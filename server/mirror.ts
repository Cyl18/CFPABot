import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { commentVersionDir, compareMc, parseLangPath, type LangPath } from "./domain/path.ts";
import { repo } from "./env.ts";
import { runGit, runGitBytes } from "./git.ts";
import { logger } from "./log.ts";
import { getModsByIds } from "./mods/curseforge.ts";
import { mappings } from "./mods/mappings.ts";
import { paths } from "./paths.ts";
import { readJson, writeJson, withLock } from "./store.ts";
import type { ModEntry, ModList } from "../shared/api.ts";

const log = logger("mirror");
const MIRROR_URL = `https://github.com/${repo.owner}/${repo.name}.git`;
const MODLIST_PATH = join(paths.cache, "modlist.json");
const ID_BATCH = 50;

async function fetchHead(): Promise<void> {
  await git(["fetch", "--depth", "1", "origin", repo.defaultBranch]);
  await git(["update-ref", `refs/heads/${repo.defaultBranch}`, "FETCH_HEAD"]);
}

function git(args: string[], cwd = paths.mirror): Promise<string> {
  return runGit(cwd, args, null);
}

async function readHeadSha(): Promise<string | null> {
  if (!(await stat(join(paths.mirror, ".git")).catch(() => null))) return null;
  try {
    return (await git(["rev-parse", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

let knownHead: string | null = null;
let listing: { head: string; files: Promise<readonly LangPath[]> } | null = null;

async function headSha(): Promise<string | null> {
  knownHead ??= await readHeadSha();
  return knownHead;
}

async function listLangFiles(rev: string): Promise<readonly LangPath[]> {
  const out = await git(["ls-tree", "-r", "--name-only", rev]);
  const files: LangPath[] = [];
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (!path) continue;
    const parsed = parseLangPath(path);
    if (parsed) files.push(parsed);
  }
  return files;
}

async function ensureMirror(): Promise<void> {
  if (await stat(join(paths.mirror, ".git")).catch(() => null)) return;
  await rm(paths.mirror, { recursive: true, force: true });
  await git(
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      repo.defaultBranch,
      MIRROR_URL,
      paths.mirror,
    ],
    paths.root,
  );
}

async function curseforgeNames(ids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    try {
      for (const mod of await getModsByIds(batch)) names.set(mod.id, mod.name);
    } catch (err) {
      log.warn("获取 CurseForge 模组名称失败", { err });
      break;
    }
  }
  return names;
}

export const mirror = {
  async sync(): Promise<{ headSha: string; changed: boolean }> {
    return withLock("mirror", async () => {
      const before = await readHeadSha();
      await ensureMirror();
      if (before !== null) {
        for (let attempt = 0; ; attempt++) {
          try {
            await fetchHead();
            break;
          } catch (err) {
            if (attempt > 0) throw err;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        }
      }
      const after = await readHeadSha();
      knownHead = after;
      return { headSha: after ?? "", changed: after !== before };
    });
  },

  headSha,

  async langFiles(): Promise<readonly LangPath[]> {
    const head = await headSha();
    if (head === null) return listLangFiles("HEAD");
    if (listing?.head !== head) {
      const files = listLangFiles(head);
      listing = { head, files };
      files.catch(() => {
        if (listing?.files === files) listing = null;
      });
    }
    return listing.files;
  },

  async readMany(rev: string, files: readonly string[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    if (files.length === 0) return texts;
    const input = new TextEncoder().encode(files.map((path) => `${rev}:${path}\n`).join(""));
    const out = new Uint8Array(await runGitBytes(paths.mirror, ["cat-file", "--batch"], null, input));
    const decoder = new TextDecoder();
    let pos = 0;
    for (const path of files) {
      const eol = out.indexOf(0x0a, pos);
      if (eol < 0) break;
      const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(decoder.decode(out.subarray(pos, eol)));
      pos = eol + 1;
      if (!header) continue;
      const size = Number(header[2]);
      if (header[1] === "blob") texts.set(path, decoder.decode(out.subarray(pos, pos + size)));
      pos += size + 1;
    }
    return texts;
  },

  async modVersions(slug: string): Promise<{ version: string; namespaces: string[] }[]> {
    const rev = (await headSha()) ?? "HEAD";
    const out = await git(["ls-tree", "-r", "--name-only", rev, `projects/assets/${slug}`]);
    const zhFiles: LangPath[] = [];
    for (const line of out.split("\n")) {
      const parsed = parseLangPath(line.trim());
      if (parsed && parsed.locale === "zh_cn" && parsed.slug === slug) zhFiles.push(parsed);
    }
    const texts = await mirror.readMany(rev, zhFiles.map((file) => file.path));
    const grouped = new Map<string, Set<string>>();
    for (const file of zhFiles) {
      const text = texts.get(file.path);
      if (text === undefined || text.trim() === "{}") continue;
      const namespaces = grouped.get(file.version) ?? new Set<string>();
      namespaces.add(file.namespace);
      grouped.set(file.version, namespaces);
    }
    return [...grouped.entries()]
      .flatMap(([version, namespaces]) => {
        const parsed = commentVersionDir(version);
        return parsed === null ? [] : [{ parsed, version, namespaces: [...namespaces].sort() }];
      })
      .sort(
        (a, b) =>
          a.parsed.index - b.parsed.index ||
          (a.parsed.loader === "fabric" ? 1 : 0) - (b.parsed.loader === "fabric" ? 1 : 0),
      )
      .map(({ version, namespaces }) => ({ version, namespaces }));
  },

  async modList(): Promise<ModList> {
    const head = await headSha();
    const cached = await readJson<ModList>(MODLIST_PATH);
    if (cached && head !== null && cached.headSha === head) return cached;

    const grouped = new Map<string, Map<string, Set<string>>>();
    for (const file of await mirror.langFiles()) {
      const versions = grouped.get(file.slug) ?? new Map<string, Set<string>>();
      const namespaces = versions.get(file.version) ?? new Set<string>();
      namespaces.add(file.namespace);
      versions.set(file.version, namespaces);
      grouped.set(file.slug, versions);
    }

    const mappingList = await mappings.list();
    const idsBySlug = new Map(mappingList.map((entry) => [entry.slug, entry.curseforgeId]));
    const names = await curseforgeNames([...new Set(idsBySlug.values())]);

    const mods: ModEntry[] = [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([slug, versions]) => {
        const curseforgeId = idsBySlug.get(slug);
        const name = curseforgeId === undefined ? undefined : names.get(curseforgeId);
        return {
          slug,
          ...(name ? { name } : {}),
          ...(curseforgeId === undefined ? {} : { curseforgeId }),
          versions: [...versions.entries()]
            .sort((a, b) => compareMc(a[0], b[0]))
            .map(([version, namespaces]) => ({ version, namespaces: [...namespaces].sort() })),
        };
      });

    const result: ModList = { updatedAt: new Date().toISOString(), headSha: head, mods };
    await writeJson(MODLIST_PATH, result);
    return result;
  },
};
