import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commentVersionDir, compareMc, langFormatFor, parseLangPath, type LangPath } from "./domain/path.ts";
import { env, repo } from "./env.ts";
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
const ID_BATCH = 1000;
const MODLIST_SCHEMA = 3;
const PREFETCH_CHUNK = 2000;

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

interface CfMeta {
  slug: string;
  name: string;
  url: string | null;
}

async function curseforgeMeta(ids: number[]): Promise<Map<number, CfMeta>> {
  const meta = new Map<number, CfMeta>();
  if (!env.CURSEFORGE_API_KEY) return meta;
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    for (const mod of await getModsByIds(batch)) {
      meta.set(mod.id, { slug: mod.slug, name: mod.name, url: mod.links?.websiteUrl ?? null });
    }
  }
  return meta;
}

const modlistCacheSchema = z.object({
  schema: z.number(),
  updatedAt: z.string(),
  headSha: z.string().nullable(),
  mappingsStamp: z.string().nullable(),
  mods: z.array(z.custom<ModEntry>()),
});

type ModlistCache = z.infer<typeof modlistCacheSchema>;

function modlistFresh(cache: ModlistCache | null, head: string | null, stamp: string | null): cache is ModlistCache {
  return (
    cache !== null &&
    cache.schema === MODLIST_SCHEMA &&
    cache.mappingsStamp === stamp &&
    (head === null ? cache.headSha === null : cache.headSha === head)
  );
}

async function blobOids(rev: string, wanted: ReadonlySet<string>): Promise<Map<string, string>> {
  const out = await git(["ls-tree", "-r", rev, "--", "projects/assets"]);
  const oids = new Map<string, string>();
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    if (!wanted.has(path)) continue;
    const parts = line.slice(0, tab).split(" ");
    const oid = parts[2];
    if (parts[1] === "blob" && oid !== undefined) oids.set(path, oid);
  }
  return oids;
}

async function ensureBlobs(oids: readonly string[]): Promise<void> {
  if (oids.length === 0) return;
  const local = new Set(
    (await git(["cat-file", "--batch-check", "--batch-all-objects"]))
      .split("\n")
      .map((line) => line.slice(0, line.indexOf(" ")))
      .filter((oid) => oid !== ""),
  );
  const missing = oids.filter((oid) => !local.has(oid));
  for (let i = 0; i < missing.length; i += PREFETCH_CHUNK) {
    const chunk = missing.slice(i, i + PREFETCH_CHUNK);
    await runGitBytes(
      paths.mirror,
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "origin",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      null,
      new TextEncoder().encode(`${chunk.join("\n")}\n`),
    );
  }
}

async function buildModList(head: string | null, mappingsStamp: string | null): Promise<ModlistCache> {
  const rev = head ?? "HEAD";
  const files = await mirror.langFiles();
  const grouped = new Map<string, Map<string, Set<string>>>();
  for (const file of files) {
    const versions = grouped.get(file.slug) ?? new Map<string, Set<string>>();
    const namespaces = versions.get(file.version) ?? new Set<string>();
    namespaces.add(file.namespace);
    versions.set(file.version, namespaces);
    grouped.set(file.slug, versions);
  }

  const zhFiles = files.filter((file) => file.locale === "zh_cn" && file.format === langFormatFor(file.version));
  const oids = await blobOids(rev, new Set(zhFiles.map((file) => file.path)));
  await ensureBlobs([...oids.values()]);
  const texts = await mirror.readBlobs([...new Set(oids.values())]);
  const zhDomains = new Map<string, Set<string>>();
  for (const file of zhFiles) {
    const oid = oids.get(file.path);
    const text = oid === undefined ? undefined : texts.get(oid);
    if (text === undefined || text.trim() === "{}") continue;
    const key = `${file.slug}\n${file.version}`;
    const domains = zhDomains.get(key) ?? new Set<string>();
    domains.add(file.namespace);
    zhDomains.set(key, domains);
  }

  const mappingList = await mappings.list();
  const idsBySlug = new Map(
    mappingList.filter((entry) => grouped.has(entry.slug)).map((entry) => [entry.slug, entry.curseforgeId]),
  );
  const meta = await curseforgeMeta([...new Set(idsBySlug.values())]);

  const mods: ModEntry[] = [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slug, versions]) => {
      const curseforgeId = idsBySlug.get(slug);
      const info = curseforgeId === undefined ? undefined : meta.get(curseforgeId);
      return {
        slug,
        ...(info === undefined ? {} : { cfSlug: info.slug }),
        ...(info && info.name ? { name: info.name } : {}),
        ...(info?.url ? { cfUrl: info.url } : {}),
        ...(curseforgeId === undefined ? {} : { curseforgeId }),
        versions: [...versions.entries()]
          .sort((a, b) => compareMc(a[0], b[0]))
          .map(([version, namespaces]) => ({
            version,
            namespaces: [...namespaces].sort(),
            zhDomains: [...(zhDomains.get(`${slug}\n${version}`) ?? [])].sort(),
          })),
      };
    });

  return { schema: MODLIST_SCHEMA, updatedAt: new Date().toISOString(), headSha: head, mappingsStamp, mods };
}

function parseCatFileBatch(out: Uint8Array, keys: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>();
  const decoder = new TextDecoder();
  let pos = 0;
  for (const key of keys) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) break;
    const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(decoder.decode(out.subarray(pos, eol)));
    pos = eol + 1;
    if (!header) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") texts.set(key, decoder.decode(out.subarray(pos, pos + size)));
    pos += size + 1;
  }
  return texts;
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
    if (files.length === 0) return new Map();
    const input = new TextEncoder().encode(files.map((path) => `${rev}:${path}\n`).join(""));
    const out = new Uint8Array(await runGitBytes(paths.mirror, ["cat-file", "--batch"], null, input));
    return parseCatFileBatch(out, files);
  },

  async readBlobs(oids: readonly string[]): Promise<Map<string, string>> {
    if (oids.length === 0) return new Map();
    const input = new TextEncoder().encode(`${oids.join("\n")}\n`);
    const out = new Uint8Array(await runGitBytes(paths.mirror, ["cat-file", "--batch"], null, input));
    return parseCatFileBatch(out, oids);
  },

  async existing(rev: string, files: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (files.length === 0) return found;
    const input = new TextEncoder().encode(files.map((path) => `${rev}:${path}\n`).join(""));
    const out = new TextDecoder().decode(await runGitBytes(paths.mirror, ["cat-file", "--batch-check"], null, input));
    const lines = out.split("\n");
    for (let i = 0; i < files.length; i++) {
      const line = lines[i];
      const path = files[i];
      if (line !== undefined && path !== undefined && /^[0-9a-f]+ blob \d+$/.test(line)) found.add(path);
    }
    return found;
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
    const stamp = await mappings.stamp();
    const cached = await readJson(MODLIST_PATH, modlistCacheSchema);
    const stale = cached !== null && cached.schema === MODLIST_SCHEMA ? cached : null;
    if (modlistFresh(cached, head, stamp)) return cached;
    return withLock("modlist", async () => {
      const fresh = await readJson(MODLIST_PATH, modlistCacheSchema);
      if (modlistFresh(fresh, head, stamp)) return fresh;
      let result: ModlistCache;
      try {
        result = await buildModList(head, stamp);
      } catch (err) {
        log.warn("模组列表重建失败，沿用旧缓存", { err });
        if (stale !== null) return stale;
        throw err;
      }
      await writeJson(MODLIST_PATH, result);
      return result;
    });
  },
};
