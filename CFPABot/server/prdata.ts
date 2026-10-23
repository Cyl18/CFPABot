import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compareMc, parseLangPath } from "@cfpa/review-core/domain/path";
import { gh, isRateLimited, type GhFile, type GhPull } from "./github/client.ts";
import { logger } from "./log.ts";
import { paths } from "./paths.ts";
import { readJson, removeFile, withLock, writeJson } from "./store.ts";
import { ttlCache } from "./ttl.ts";
import type { PrState, PrSummary, RelatedPr } from "@cfpa/contracts/api";

const log = logger("prdata");
const INDEX_PATH = join(paths.cache, "prs.json");
const PR_DIR = join(paths.cache, "pr");
const DRIP_DELAY_MS = 300;
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
let listed = new Map<number, GhPull>();
let dripping: Promise<void> | null = null;
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
  if (pull.state === "open") {
    await writeJson(prPath(pull.number), cache);
    meta.set(pull.number, { headSha: cache.headSha, slugs: cache.slugs, entries });
    openIndex.set(pull.number, summarize(pull, cache.slugs));
  }
  fileCaches.set(String(pull.number), cache);
  return cache;
}

/** head 没变时文件列表不用重拉，但 pull 快照必须跟着刷新，否则标题、标签、baseSha 永远停在旧值。 */
async function touchPull(pull: GhPull): Promise<void> {
  const cached = fileCaches.get(String(pull.number)) ?? (await readJson(prPath(pull.number), cacheSchema));
  if (!cached || cached.headSha !== pull.headSha) return;
  if (JSON.stringify(cached.pull) === JSON.stringify(pull)) return;
  await storePull(pull, cached.files);
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

async function loadMetaFromDisk(): Promise<void> {
  const names = await readdir(PR_DIR).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const cached = await readJson(join(PR_DIR, name), cacheSchema);
    if (cached?.pull.state === "open") {
      meta.set(cached.pull.number, { headSha: cached.headSha, slugs: cached.slugs, entries: cached.entries });
      if (!openIndex.has(cached.pull.number)) openIndex.set(cached.pull.number, summarize(cached.pull, cached.slugs));
    } else if (cached !== null) {
      await removeFile(join(PR_DIR, name));
    }
  }
}

async function refreshList(): Promise<void> {
  await withLock("prdata", async () => {
    const pulls = await gh.listPulls("open");
    listed = new Map(pulls.map((pull) => [pull.number, pull]));
    for (const pull of pulls) openIndex.set(pull.number, summarize(pull, meta.get(pull.number)?.slugs ?? []));
    for (const number of [...openIndex.keys()]) {
      if (!listed.has(number)) openIndex.delete(number);
    }
    for (const number of [...meta.keys()]) {
      if (!listed.has(number)) await drop(number);
    }
    rebuildRelation();
    refreshedAt = new Date().toISOString();
    await persistIndex();
    closedList.delete("closed");
  });
}

/** 服务起来之后逐个补 PR 文件缓存；匿名模式只走懒加载，撞限流就停，下一轮再接着补。 */
async function dripOnce(): Promise<void> {
  if (gh.mode === "anonymous" || listed.size === 0) return;
  for (const pull of listed.values()) {
    if (meta.get(pull.number)?.headSha === pull.headSha) {
      await touchPull(pull).catch((err: unknown) => log.warn("PR 快照更新失败", { pr: pull.number, err }));
      continue;
    }
    try {
      const files = await gh.listPullFiles(pull.number);
      await withLock("prdata", () => storePull(pull, files));
    } catch (err) {
      if (isRateLimited(err)) {
        log.warn("GitHub 速率限制，暂停 PR 文件缓存预取", { pr: pull.number });
        break;
      }
      log.warn("获取 PR 文件列表失败", { pr: pull.number, err });
      continue;
    }
    await Bun.sleep(DRIP_DELAY_MS);
  }
  await withLock("prdata", async () => {
    rebuildRelation();
    await persistIndex();
  });
}

function drip(): Promise<void> {
  dripping ??= dripOnce()
    .catch((err: unknown) => log.warn("PR 文件缓存预取中断", { err }))
    .finally(() => {
      dripping = null;
    });
  return dripping;
}

export const prdata = {
  /** 冷启动只翻 PR 列表；文件缓存交给 drip()，等服务起来之后再慢慢补。 */
  async init(): Promise<void> {
    if (loaded) return;
    const index = await readJson(INDEX_PATH, indexSchema);
    if (index) {
      for (const pull of index.pulls) openIndex.set(pull.number, pull);
      refreshedAt = index.updatedAt;
    }
    await loadMetaFromDisk();
    loaded = true;
    await refreshList().catch((err: unknown) => log.warn("PR 列表刷新失败", { err }));
  },

  drip,

  async refreshAll(): Promise<void> {
    await refreshList();
    await drip();
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
      } else {
        await touchPull(pull);
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
    if (stored.pull.state === "open") await persistIndex();
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
