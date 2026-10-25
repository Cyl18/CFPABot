import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compareMc } from "@cfpa/review-core/domain/path";
import { langEntriesOf, summarizePr, type FileSource } from "./domain/pr.ts";
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
const inflight = new Map<number, Promise<PrFileCache>>();
const lastChecked = new Map<number, number>();
const closedList = ttlCache<PrSummary[]>(CLOSED_TTL_MS, 4);
let listed = new Map<number, GhPull>();
let listedAt = 0;
let dripping: Promise<void> | null = null;
let refreshedAt: string | null = null;
let loaded = false;

function prPath(n: number): string {
  return join(PR_DIR, `${n}.json`);
}



function byUpdatedDesc(list: PrSummary[]): PrSummary[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function storePull(pull: GhPull, files: GhFile[]): Promise<PrFileCache> {
  const { slugs, entries } = langEntriesOf(files);
  const cache: PrFileCache = {
    headSha: pull.headSha,
    pull,
    files,
    slugs,
    entries,
    updatedAt: new Date().toISOString(),
  };
  if (pull.state === "open") {
    await writeJson(prPath(pull.number), cache);
    meta.set(pull.number, { headSha: cache.headSha, slugs: cache.slugs, entries });
    openIndex.set(pull.number, summarizePr(pull, cache.slugs));
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
  lastChecked.delete(n);
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
      if (!openIndex.has(cached.pull.number)) openIndex.set(cached.pull.number, summarizePr(cached.pull, cached.slugs));
    } else if (cached !== null) {
      await removeFile(join(PR_DIR, name));
    }
  }
}

async function refreshList(): Promise<void> {
  await withLock("prdata", async () => {
    const startedAt = Date.now();
    const pulls = await gh.listPulls("open");
    listed = new Map(pulls.map((pull) => [pull.number, pull]));
    listedAt = startedAt;
    for (const pull of pulls) openIndex.set(pull.number, summarizePr(pull, meta.get(pull.number)?.slugs ?? []));
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
  const snapshotAt = listedAt;
  for (const pull of listed.values()) {
    // 列表抓取后又被 webhook 刷新过的 PR，缓存比快照新；拿旧 pull 回写会把 headSha 和文件配错。
    const cached = fileCaches.get(String(pull.number)) ?? (await readJson(prPath(pull.number), cacheSchema));
    if (cached !== null && Date.parse(cached.updatedAt) > snapshotAt) continue;
    try {
      const refetched = await withLock("prdata", async () => {
        if (meta.get(pull.number)?.headSha === pull.headSha) {
          await touchPull(pull);
          return false;
        }
        await storePull(pull, await gh.listPullFiles(pull.number));
        return true;
      });
      if (!refetched) continue;
    } catch (err) {
      if (isRateLimited(err)) {
        log.warn("GitHub 速率限制，暂停 PR 文件缓存预取", { pr: pull.number });
        break;
      }
      log.warn("PR 缓存预取失败", { pr: pull.number, err });
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

async function loadFiles(n: number): Promise<PrFileCache> {
  return withLock("prdata", async () => {
    const indexHead = openIndex.get(n)?.headSha;
    const checkedAt = lastChecked.get(n) ?? 0;
    const fresh = Date.now() - checkedAt < 60_000;
    const cached = fileCaches.get(String(n));
    if (cached && fresh && (indexHead === undefined || indexHead === cached.headSha)) return cached;
    const onDisk = fresh ? await readJson(prPath(n), cacheSchema) : null;
    if (onDisk && fresh && (indexHead === undefined || indexHead === onDisk.headSha)) {
      fileCaches.set(String(n), onDisk);
      if (onDisk.pull.state === "open") {
        meta.set(n, { headSha: onDisk.headSha, slugs: onDisk.slugs, entries: onDisk.entries });
      }
      return onDisk;
    }
    const pull = await gh.getPull(n);
    lastChecked.set(n, Date.now());
    if (cached && cached.headSha === pull.headSha) {
      await touchPull(pull);
      return fileCaches.get(String(n)) ?? cached;
    }
    if (onDisk && onDisk.headSha === pull.headSha) {
      await touchPull(pull);
      return fileCaches.get(String(n)) ?? onDisk;
    }
    const stored = await storePull(pull, await gh.listPullFiles(n));
    if (stored.pull.state === "open") await persistIndex();
    return stored;
  });
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
    void refreshList()
      .then(() => drip())
      .catch((err: unknown) => log.warn("PR 列表刷新失败", { err }));
  },

  drip,

  async refreshAll(): Promise<void> {
    await refreshList();
    await drip();
  },

  async refresh(n: number): Promise<void> {
    await withLock("prdata", async () => {
      const pull = await gh.getPull(n);
      lastChecked.set(n, Date.now());
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
      openIndex.set(n, summarizePr(pull, meta.get(n)?.slugs ?? []));
      rebuildRelation();
      refreshedAt = new Date().toISOString();
      await persistIndex();
    });
  },

  async list(state: PrState | "all"): Promise<PrSummary[]> {
    if (state === "open") return byUpdatedDesc([...openIndex.values()]);
    const closed = await closedList.wrap("closed", async () => {
      const pulls = await gh.listPulls("closed");
      return pulls.map((pull) => summarizePr(pull, []));
    });
    if (state === "closed") return byUpdatedDesc(closed.filter((pull) => pull.state === "closed"));
    if (state === "merged") return byUpdatedDesc(closed.filter((pull) => pull.state === "merged"));
    return byUpdatedDesc([...openIndex.values(), ...closed]);
  },

  async files(n: number): Promise<PrFileCache> {
    const indexHead = openIndex.get(n)?.headSha;
    const cached = fileCaches.get(String(n));
    const fresh = Date.now() - (lastChecked.get(n) ?? 0) < 60_000;
    if (cached && fresh && (indexHead === undefined || indexHead === cached.headSha)) return cached;
    const pending = inflight.get(n);
    if (pending !== undefined) return pending;
    const run = loadFiles(n);
    inflight.set(n, run);
    void run.finally(() => {
      if (inflight.get(n) === run) inflight.delete(n);
    }).catch(() => undefined);
    return run;
  },

  /** 同一次请求内重复读同一文件只发一次；gh.getFile 只缓存结果，不合并并发。 */
  fileSource(): FileSource {
    const reads = new Map<string, Promise<string | null>>();
    return {
      read(path, ref) {
        if (path === null) return Promise.resolve(null);
        const key = `${ref}\u0000${path}`;
        let pending = reads.get(key);
        if (pending === undefined) {
          pending = gh.getFile(path, ref);
          reads.set(key, pending);
        }
        return pending;
      },
      readMany: (paths, ref) => gh.getFiles(paths, ref),
    };
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
