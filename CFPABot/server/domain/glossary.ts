import { cp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../git.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { withLock } from "../store.ts";
import { loadTermIndex, type TermIndex } from "@cfpa/review-core/domain/terms";

const log = logger("glossary");
const GLOSSARY_URL = "https://github.com/CFPAOrg/Glossary.git";
const GLOSSARY_BRANCH = "main";
const TERMS_SUBDIR = "Vanilla/terms";
const CLONE_DIR = join(paths.cache, "glossary");
const SYNC_RETRY_MS = 10 * 60 * 1000;

export const TERMS_DIR = join(paths.config, "vanilla-terms");

let lastFailedAt = 0;
let cachedIndex: TermIndex | null = null;
let cachedStamp = -1;

async function ensureClone(): Promise<void> {
  if (await stat(join(CLONE_DIR, ".git")).catch(() => null)) return;
  await rm(CLONE_DIR, { recursive: true, force: true });
  await runGit(
    paths.root,
    ["clone", "--depth", "1", "--single-branch", "--branch", GLOSSARY_BRANCH, GLOSSARY_URL, CLONE_DIR],
    null,
  );
}

export async function syncGlossary(): Promise<{ revision: string; files: number }> {
  return withLock("glossary", async () => {
    await ensureClone();
    await runGit(CLONE_DIR, ["fetch", "--depth", "1", "origin", GLOSSARY_BRANCH], null);
    await runGit(CLONE_DIR, ["reset", "--hard", "FETCH_HEAD"], null);
    const revision = (await runGit(CLONE_DIR, ["rev-parse", "HEAD"], null)).trim();
    const listed = (await runGit(CLONE_DIR, ["ls-files", TERMS_SUBDIR], null))
      .split("\n")
      .filter((line) => line.endsWith(".tsv"));
    const temp = `${TERMS_DIR}.tmp`;
    await rm(temp, { recursive: true, force: true });
    await cp(join(CLONE_DIR, TERMS_SUBDIR), temp, { recursive: true });
    await rm(TERMS_DIR, { recursive: true, force: true });
    await rename(temp, TERMS_DIR);
    log.info("术语表已同步", { revision, files: listed.length });
    return { revision, files: listed.length };
  });
}

async function load(): Promise<TermIndex | null> {
  try {
    const info = await stat(TERMS_DIR).catch(() => null);
    if (cachedIndex !== null && (info === null || info.mtimeMs === cachedStamp)) return cachedIndex;
    const index = await loadTermIndex(TERMS_DIR);
    if (index.all.length === 0) return null;
    cachedIndex = index;
    cachedStamp = info?.mtimeMs ?? -1;
    return index;
  } catch (err) {
    log.warn("术语表加载失败", { err });
    return null;
  }
}

export async function glossaryTerms(): Promise<TermIndex | null> {
  const cached = await load();
  if (cached !== null) return cached;
  if (Date.now() - lastFailedAt < SYNC_RETRY_MS) return null;
  try {
    await syncGlossary();
  } catch (err) {
    lastFailedAt = Date.now();
    log.warn("术语表同步失败", { err });
    return null;
  }
  return load();
}
