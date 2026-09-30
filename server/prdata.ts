import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compareMc, parseLangPath } from "./domain/path.ts";
import { gh, type GhFile, type GhPull } from "./github/client.ts";
import { logger } from "./log.ts";
import { paths } from "./paths.ts";
import { readJson, removeFile, withLock, writeJson } from "./store.ts";
import { ttlCache } from "./ttl.ts";
import type { PrState, PrSummary, RelatedPr } from "../shared/api.ts";

const log = logger("prdata");
const INDEX_PATH = join(paths.cache, "prs.json");
const PR_DIR = join(paths.cache, "pr");
const CONCURRENCY = 6;
const FILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FILE_CACHE_MAX = 30;
const CLOSED_TTL_MS = 5 * 60 * 1000;

const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  draft: z.boolean(),
  author: z.string(),
  authorId: z.number(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  htmlUrl: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  headRepoOwner: z.string().nullable(),
  headRepoName: z.string().nullable(),
  maintainerCanModify: z.boolean().nullable().default(null),
});

const fileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number(),
  deletions: z.number(),
  previousPath: z.string().optional(),
  patch: z.string().optional(),
});

const cacheSchema = z.object({
  headSha: z.string(),
  pull: pullSchema,
  files: z.array(fileSchema),
  slugs: z.array(z.string()),
  entries: z.array(z.object({ slug: z.string(), version: z.string() })),
  updatedAt: z.string(),
});

const summarySchema = z.object({
  number: z.number(),
  title: z.string(),
  author: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  headSha: z.string(),
  slugs: z.array(z.string()),
});

const indexSchema = z.object({
  updatedAt: z.string().nullable(),
  pulls: z.array(summarySchema),
});

type PrFileCache = z.infer<typeof cacheSchema>;
type PrMeta = Pick<PrFileCache, "headSha" | "slugs" | "entries">;

const openIndex = new Map<number, PrSummary>();
const meta = new Map<number, PrMeta>();
const relation = new Map<string, Map<number, Set<string>>>();
const fileCaches = ttlCache<PrFileCache>(FILE_CACHE_TTL_MS, FILE_CACHE_MAX);
const closedList = ttlCache<PrSummary[]>(CLOSED_TTL_MS, 4);
let refreshedAt: string | null = null;
let loaded = false;

function prPath(n: number): string {
  return join(PR_DIR, `${n}.json`);
}

function summarize(pull: GhPull, slugs: string[]): PrSummary {
  return {
    number: pull.number,
    title: pull.title,
    author: pull.author,
    state: pull.state === "open" ? "open" : pull.merged ? "merged" : "closed",
    draft: pull.draft,
    labels: pull.labels,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    headSha: pull.headSha,
    slugs: [...slugs].sort(),
  };
}

function byUpdatedDesc(list: PrSummary[]): PrSummary[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function storePull(pull: GhPull, files: GhFile[]): Promise<PrFileCache> {
  const slugs = new Set<string>();
  const entries: { slug: string; version: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (!parsed) continue;
    slugs.add(parsed.slug);
    const key = `${parsed.slug}\u0000${parsed.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ slug: parsed.slug, version: parsed.version });
  }
  const cache: PrFileCache = {
    headSha: pull.headSha,
    pull,
    files,
    slugs: [...slugs].sort(),
    entries,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(prPath(pull.number), cache);
  fileCaches.set(String(pull.number), cache);
  if (pull.state === "open") meta.set(pull.number, { headSha: cache.headSha, slugs: cache.slugs, entries });
  return cache;
}

function rebuildRelation(): void {
  relation.clear();
  for (const [number, entry] of meta) {
    for (const item of entry.entries) {
      const byPr = relation.get(item.slug) ?? new Map<number, Set<string>>();
      const versions = byPr.get(number) ?? new Set<string>();
      versions.add(item.version);
      byPr.set(number, versions);
      relation.set(item.slug, byPr);
    }
  }
}

async function persistIndex(): Promise<void> {
  await writeJson(INDEX_PATH, { updatedAt: refreshedAt, pulls: [...openIndex.values()] });
}

async function drop(n: number): Promise<void> {
  meta.delete(n);
  fileCaches.delete(String(n));
  openIndex.delete(n);
  await removeFile(prPath(n));
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function loadMetaFromDisk(): Promise<void> {
  const names = await readdir(PR_DIR).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const cached = await readJson(join(PR_DIR, name), cacheSchema);
    if (cached?.pull.state === "open") {
      meta.set(cached.pull.number, { headSha: cached.headSha, slugs: cached.slugs, entries: cached.entries });
      if (!openIndex.has(cached.pull.number)) openIndex.set(cached.pull.number, summarize(cached.pull, cached.slugs));
    }
  }
}

export const prdata = {
  async init(): Promise<void> {
    if (loaded) return;
    const index = await readJson(INDEX_PATH, indexSchema);
    if (index) {
      for (const pull of index.pulls) openIndex.set(pull.number, pull);
      refreshedAt = index.updatedAt;
    }
    await loadMetaFromDisk();
    loaded = true;
    void prdata.refreshAll().catch((err: unknown) => log.warn("PR 缓存刷新失败", { err }));
  },

  async refreshAll(): Promise<void> {
    await withLock("prdata", async () => {
      const pulls = await gh.listPulls("open");
      await mapLimit(pulls, CONCURRENCY, async (pull) => {
        if (meta.get(pull.number)?.headSha === pull.headSha) return;
        try {
          await storePull(pull, await gh.listPullFiles(pull.number));
        } catch (err) {
          log.warn("获取 PR 文件列表失败", { pr: pull.number, err });
        }
      });
      const next = new Map<number, PrSummary>();
      for (const pull of pulls) next.set(pull.number, summarize(pull, meta.get(pull.number)?.slugs ?? []));
      for (const number of [...meta.keys()]) {
        if (!next.has(number)) await drop(number);
      }
      for (const number of [...openIndex.keys()]) {
        if (!next.has(number)) openIndex.delete(number);
      }
      for (const [number, summary] of next) openIndex.set(number, summary);
      rebuildRelation();
      refreshedAt = new Date().toISOString();
      await persistIndex();
      closedList.delete("closed");
    });
  },

  async refresh(n: number): Promise<void> {
    await withLock("prdata", async () => {
      const pull = await gh.getPull(n);
      if (pull.state === "closed") {
        await drop(n);
        await persistIndex();
        return;
      }
      if (meta.get(n)?.headSha !== pull.headSha) {
        await storePull(pull, await gh.listPullFiles(n));
      }
      openIndex.set(n, summarize(pull, meta.get(n)?.slugs ?? []));
      rebuildRelation();
      refreshedAt = new Date().toISOString();
      await persistIndex();
    });
  },

  async list(state: PrState | "all"): Promise<PrSummary[]> {
    if (state === "open") return byUpdatedDesc([...openIndex.values()]);
    const closed = await closedList.wrap("closed", async () => {
      const pulls = await gh.listPulls("closed");
      return pulls.map((pull) => summarize(pull, []));
    });
    if (state === "closed") return byUpdatedDesc(closed.filter((pull) => pull.state === "closed"));
    if (state === "merged") return byUpdatedDesc(closed.filter((pull) => pull.state === "merged"));
    return byUpdatedDesc([...openIndex.values(), ...closed]);
  },

  async files(n: number): Promise<{ pull: GhPull; files: GhFile[] }> {
    const indexHead = openIndex.get(n)?.headSha;
    const cached = fileCaches.get(String(n));
    if (cached && (indexHead === undefined || indexHead === cached.headSha)) return { pull: cached.pull, files: cached.files };
    const onDisk = await readJson(prPath(n), cacheSchema);
    if (onDisk && (indexHead === undefined || indexHead === onDisk.headSha)) {
      fileCaches.set(String(n), onDisk);
      if (onDisk.pull.state === "open") {
        meta.set(n, { headSha: onDisk.headSha, slugs: onDisk.slugs, entries: onDisk.entries });
      }
      return { pull: onDisk.pull, files: onDisk.files };
    }
    const pull = await gh.getPull(n);
    const stored = await storePull(pull, await gh.listPullFiles(n));
    return { pull: stored.pull, files: stored.files };
  },

  related(n: number, slugs?: readonly string[]): RelatedPr[] {
    const targets = slugs ?? meta.get(n)?.slugs;
    if (targets === undefined) return [];
    const related: RelatedPr[] = [];
    for (const slug of targets) {
      const byPr = relation.get(slug);
      if (!byPr) continue;
      for (const [other, versions] of byPr) {
        if (other === n) continue;
        const summary = openIndex.get(other);
        if (!summary) continue;
        related.push({ number: other, title: summary.title, slug, versions: [...versions].sort(compareMc) });
      }
    }
    return related;
  },

  hasRelation(slug: string): boolean {
    return relation.has(slug);
  },

  stats(): { openCount: number; refreshedAt: string | null } {
    return { openCount: openIndex.size, refreshedAt };
  },
};
