// src/client/pr-relations-cache.ts
// Stateful PR relation cache: tracks curseforge slugs across open PRs.
//
// Responsibilities (after Batch 5 split):
//   - Disk cache of PR file lists (read / write / remove {prId}.json)
//   - Slug → PR cross-reference map (in-memory) + rebuild
//   - Query API (getRelation / getRelationsForPR)
//   - Single-PR refresh with headSha short-circuit
//
// Orchestration (listing, watermark advance, full/batch refresh pipeline)
// has been moved to src/flows/_internal/refresh-pr-cache.ts.

import { readdir } from "node:fs/promises";
import { writeJsonLocked, readJsonFile, removeFile } from "../_shared/fs-utils.js";
import type { Logger } from "../types.js";
import type { GitHubClient, PullRequestFile, PullRequestListItem } from "./github/index.js";
import { parseProjectPath } from "../flows/_shared/project-path/index.js";
import type { PRRelationEntry } from "../flows/_shared/project-path/index.js";
import * as prIndex from "../engine/pr-index.js";
import { mapPrIndexEntry } from "../engine/pr-index.js";
import { PR_FILES_DIR, PR_FILES_WATERMARK_PATH } from "../runtime-paths.js";
// Re-export types for consumers
export type { PRRelationEntry } from "../flows/_shared/project-path/index.js";

// ─── Internal cache of PR file lists ────────────────────────────────

interface PRFilesCache {
  prid: number;
  headSha: string;
  files: string[];
  updatedAt: string;
}

const CACHE_DIR = PR_FILES_DIR;

// ─── Module logger (injected once at bootstrap) ────────────────────────

let _logger: Logger | null = null;

/** Inject the shared logger so this module logs via pino (file + Logs UI). */
export function initPrCacheLogger(logger: Logger): void {
  _logger = logger;
}

// ─── Watermark persistence ─────────────────────────────────────────

const WATERMARK_PATH = PR_FILES_WATERMARK_PATH;
export async function readListWatermark(): Promise<string | null> {
  const data = await readJsonFile<{ updatedAt: string }>(WATERMARK_PATH);
  return data?.updatedAt ?? null;
}

export async function writeListWatermark(isoString: string): Promise<void> {
  await writeJsonLocked(
    WATERMARK_PATH,
    { updatedAt: isoString },
    "pr-relation:watermark",
  );
}

export function maxUpdatedAt(prs: PullRequestListItem[]): string | null {
  if (prs.length === 0) return null;
  return prs.reduce((max, p) => (p.updated_at > max ? p.updated_at : max), prs[0]!.updated_at);
}

// ─── Module state ────────────────────────────────────────────────────

/** slug -> set of (PR#, version) pairs */
let relation = new Map<string, Set<PRRelationEntry>>();

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Coalesces concurrent batchRefreshFromList calls. Set back to null by the
 * finally-block inside batchRefreshFromList once the batch completes.
 */
let fullRefreshInFlight: Promise<PrBatchResult> | null = null;

/**
 * Coalesces concurrent fullListAndRefresh callers so only one list+batch
 * pipeline runs at a time within this process.
 */
let listAndRefreshInFlight: Promise<PrBatchResult> | null = null;

/**
 * Timestamp (Date.now()) of the last full batch refresh completed in this process.
 * Used by cron's shouldSkip to avoid running twice within 4 hours.
 * Null means no full refresh has completed yet this process lifetime.
 */
export let lastFullRefreshAt: number | null = null;

// ─── Internal rebuild ────────────────────────────────────────────────

async function rebuildRelation(): Promise<void> {
  const newRelation = new Map<string, Set<PRRelationEntry>>();

  const prFilesList = await loadAllCachedPRFiles();
  for (const cache of prFilesList) {
    for (const filePath of cache.files) {
      const parsed = parseProjectPath(filePath);
      if (!parsed) continue;

      const entry: PRRelationEntry = {
        prNumber: cache.prid,
        version: parsed.gameVersion,
      };

      const existing = newRelation.get(parsed.slug);
      if (existing) {
        existing.add(entry);
      } else {
        newRelation.set(parsed.slug, new Set([entry]));
      }
    }
  }

  relation = newRelation;
}

// ─── Disk cache CRUD ─────────────────────────────────────────────────

async function cachePRFiles(
  client: GitHubClient,
  prId: number,
  headSha: string,
): Promise<void> {
  const files: PullRequestFile[] = await client.getPullRequestFiles(prId);

  const cache: PRFilesCache = {
    prid: prId,
    headSha,
    files: files.map((f) => f.filename),
    updatedAt: new Date().toISOString(),
  };

  const cachePath = `${CACHE_DIR}/${prId}.json`;
  await writeJsonLocked(cachePath, cache, `pr-relation:${prId}`);
}

export async function removeCachedPR(prId: number): Promise<void> {
  await prIndex.remove(prId);
  await removeFile(`${CACHE_DIR}/${prId}.json`);
}

async function loadAllCachedPRFiles(): Promise<PRFilesCache[]> {
  const results: PRFilesCache[] = [];

  try {
    const entries = await readdir(CACHE_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const cache = await readJsonFile<PRFilesCache>(
          `${CACHE_DIR}/${entry}`,
        );
        if (cache) results.push(cache);
      } catch (e) {
        _logger?.warn({ entry, err: String(e) }, "pr-relations-cache: 损坏的缓存文件");
        // Corrupt cache file - skip
      }
    }
  } catch (e) {
    _logger?.warn({ err: String(e) }, "pr-relations-cache: 读取缓存目录失败");
    // Directory may not exist yet
  }

  return results;
}

/**
 * Load a single PR's cached file list. Returns null if not cached or corrupt.
 */
async function loadCachedPRFile(
  prId: number,
): Promise<PRFilesCache | null> {
  return readJsonFile<PRFilesCache>(`${CACHE_DIR}/${prId}.json`);
}

// ─── Shared fetch loop ──────────────────────────────────────────────

/**
 * Fetch changed PR files in batches, updating the disk cache and in-memory state.
 * Shared by batchRefreshFromList (full + stale cleanup) and incrementalRefreshFromList
 * (incremental, no stale cleanup). Concurrency is bounded to 8 requests at a time.
 */
async function fetchChangedPRFiles(
  client: GitHubClient,
  openPrs: PullRequestListItem[],
): Promise<{ refreshed: number; failed: number; skipped: number }> {
  const cachedList = await loadAllCachedPRFiles();
  const cachedByPrId = new Map(cachedList.map((c) => [c.prid, c]));

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;

  const CONCURRENCY = 8;
  for (let i = 0; i < openPrs.length; i += CONCURRENCY) {
    const batch = openPrs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (pr) => {
        const headSha = pr.head?.sha;
        if (!headSha) return; // Skip if head.sha is missing (shouldn't happen)

        const cached = cachedByPrId.get(pr.number);
        if (cached && cached.headSha === headSha) {
          skipped++;
          return; // No change — skip re-fetch
        }

        await cachePRFiles(client, pr.number, headSha);
        refreshed++;
      }),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        failed++;
        _logger?.warn({ err: String(r.reason) }, "pr-relations-cache: fetch failed for a PR");
      }
    }
  }

  return { refreshed, failed, skipped };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Result of a batch refresh operation.
 */
export interface PrBatchResult {
  refreshed: number;
  removed: number;
  failed: number;
}

/**
 * Full batch refresh: given a list of open PRs, cache files only for PRs
 * whose headSha has changed, clean stale cache entries no longer in the list,
 * rebuild the relation map once, and update lastFullRefreshAt.
 *
 * The flow layer (refresh-pr-cache.ts) is the preferred caller — this remains
 * a thin entry point so bootstrap's initRelation and pr-list's refreshIfEmpty
 * keep working without depending on flow internals.
 */
export async function batchRefreshFromList(
  client: GitHubClient,
  openPrs: PullRequestListItem[],
): Promise<PrBatchResult> {
  if (fullRefreshInFlight) {
    return fullRefreshInFlight;
  }

  fullRefreshInFlight = (async (): Promise<PrBatchResult> => {
    const { refreshed, failed } = await fetchChangedPRFiles(client, openPrs);

    // Clean stale cache entries for PRs that are no longer open
    const currentIds = new Set(openPrs.map((p) => p.number));
    const cachedList = await loadAllCachedPRFiles();
    let removed = 0;
    for (const cached of cachedList) {
      if (!currentIds.has(cached.prid)) {
        await removeCachedPR(cached.prid);
        removed++;
      }
    }

    // Single rebuild — not per PR
    await rebuildRelation();
    lastFullRefreshAt = Date.now();

    const skippedUnchanged = openPrs.length - refreshed - failed;
    _logger?.info(
      { listed: openPrs.length, skipped: skippedUnchanged, refreshed, cleaned: removed, failed },
      "pr-relations-cache: batch refresh completed",
    );

    return { refreshed, removed, failed };
  })();

  fullRefreshInFlight = fullRefreshInFlight.finally(() => {
    fullRefreshInFlight = null;
  });

  return fullRefreshInFlight;
}

/**
 * Helper for cron's shouldSkip: skip if a full batch refresh is in flight,
 * or if the last completed refresh is within maxAgeMs.
 */
export function shouldSkipFullRefresh(maxAgeMs: number): boolean {
  if (fullRefreshInFlight !== null) return true;
  if (lastFullRefreshAt !== null && Date.now() - lastFullRefreshAt < maxAgeMs) return true;
  return false;
}

/**
 * Returns true when any list+refresh pipeline is currently in flight.
 * Used by cron's shouldSkip to avoid firing a second scan while init
 * or a forced full refresh is still running.
 */
export function isPrCacheRefreshInFlight(): boolean {
  return fullRefreshInFlight !== null || listAndRefreshInFlight !== null;
}

// ─── Full list + batch (coalesced) ──────────────────────────────────

/**
 * Full list + batch refresh with stale cleanup. Coalesces concurrent
 * callers so that only one list+batch pipeline runs at a time.
 * Advances the disk watermark after completion.
 *
 * This orchestration is exposed here (rather than in the Flow layer) for
 * backwards compatibility with bootstrap's initRelation, which needs a
 * lightweight entry point without pulling in the full flow runtime.
 *
 * The flow layer (refresh-pr-cache.ts / pr_cache_refresh Flow) calls this
 * same entry point when invoked through the cron task.
 */
export async function fullListAndRefresh(client: GitHubClient): Promise<PrBatchResult> {
  if (listAndRefreshInFlight) return listAndRefreshInFlight;

  listAndRefreshInFlight = (async (): Promise<PrBatchResult> => {
    const openPrs = await client.listAllPulls({ state: "open" });

    // Update the PR index from the same list result
    await prIndex.replaceAll(openPrs.map(mapPrIndexEntry));

    const result = await batchRefreshFromList(client, openPrs);

    // Advance watermark using the max updated_at seen across all open PRs
    const max = maxUpdatedAt(openPrs);
    if (max) await writeListWatermark(max);

    return result;
  })();

  listAndRefreshInFlight = listAndRefreshInFlight.finally(() => {
    listAndRefreshInFlight = null;
  });

  return listAndRefreshInFlight;
}

// ─── Incremental refresh (no stale cleanup) ─────────────────────────

/**
 * Refresh only the PRs that have changed since the last watermark using a
 * candidate list pre-computed by the flow layer (early-stop on sort=updated).
 * Does NOT clean stale cache entries — that is fullListAndRefresh's job.
 *
 * headSha comparison still applies to skip PRs that had a label/state
 * change but no new commits.
 */
export async function incrementalRefreshFromList(
  client: GitHubClient,
  openPrs: PullRequestListItem[],
): Promise<PrBatchResult> {
  const { refreshed, failed } = await fetchChangedPRFiles(client, openPrs);

  // Upsert all candidates into the PR index so title/label/state changes
  // are reflected even when headSha hasn't changed (no file re-fetch).
  for (const pr of openPrs) {
    if (pr.state === "closed") {
      await prIndex.remove(pr.number);
    } else {
      await prIndex.upsert(mapPrIndexEntry(pr));
    }
  }

  // Single rebuild — only when something actually changed
  if (refreshed > 0) {
    await rebuildRelation();
  }

  const candidates = openPrs.length;
  _logger?.info(
    { candidates, refreshed, failed },
    "pr-relations-cache: incremental refresh completed",
  );

  return { refreshed, removed: 0, failed };
}

// ─── Incremental list ──────────────────────────────────────────────

/**
 * List open PRs using sort=updated&direction=desc, stopping paging once
 * a full page of PRs all have updated_at <= watermark.
 * Returns null when watermark is absent (caller should do a full list).
 */
export async function listChangedPrs(
  client: GitHubClient,
  watermark: string | null,
): Promise<{ candidates: PullRequestListItem[]; newWatermark: string } | null> {
  if (!watermark) return null;

  const candidates: PullRequestListItem[] = [];
  let maxUpdatedAtSeen = "";

  for (let page = 1; ; page++) {
    const pagePrs = await client.listPullsPage({
      state: "open",
      sort: "updated",
      direction: "desc",
      perPage: 100,
      page,
    });

    if (pagePrs.length === 0) break;

    // Track newest updated_at on this page for advancing the watermark
    const pageFirst = pagePrs[0]!;
    if (pageFirst.updated_at > maxUpdatedAtSeen) {
      maxUpdatedAtSeen = pageFirst.updated_at;
    }

    // Collect only PRs that were updated after the watermark
    for (const pr of pagePrs) {
      if (pr.updated_at > watermark) {
        candidates.push(pr);
      }
    }

    // Early-stop: if the last PR on this page is at or below the watermark,
    // the next page (sort=updated desc) will all be <= watermark too.
    const pageLast = pagePrs[pagePrs.length - 1]!;
    if (pageLast.updated_at <= watermark) break;

    // Last page indicator (fewer results than perPage)
    if (pagePrs.length < 100) break;
  }

  // Never regress the watermark — keep the greater of what we saw and the old value
  const newWatermark = maxUpdatedAtSeen > watermark ? maxUpdatedAtSeen : watermark;
  return { candidates, newWatermark };
}

// ─── Init + single-PR refresh ────────────────────────────────────────

/**
 * Lazy-init the relation map. Lists all open PRs (paginated, with head.sha),
 * caches only changed PR files, then rebuilds the slug->PR mapping.
 * Safe to call multiple times — subsequent calls are no-ops while the first
 * init is still running.
 */
export async function initRelation(client: GitHubClient): Promise<void> {
  if (initialized) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    try {
      await fullListAndRefresh(client);
      initialized = true;
    } finally {
      initPromise = null;
    }
  })();

  await initPromise;
}

/**
 * Refresh a single PR's cached file list and rebuild the relation map.
 * Called on PR opened / synchronize / closed events.
 *
 * Optimized to avoid double getPullRequest:
 *   1. One getPullRequest to check state and get headSha
 *   2. Compare with cached headSha — skip if unchanged
 *   3. Only getPullRequestFiles if actually changed
 *   4. Single rebuildRelation after update
 */
export async function refreshRelation(
  client: GitHubClient,
  prId: number,
): Promise<void> {
  if (!initialized) {
    await initRelation(client);
    return;
  }

  try {
    const pr = await client.getPullRequest(prId);
    const headSha = pr.head.sha;

    if (pr.state === "closed") {
      await prIndex.remove(prId);
      const cached = await loadCachedPRFile(prId);
      if (cached) {
        await removeCachedPR(prId);
        await rebuildRelation();
      }
      return;
    }

    // Always upsert the index entry so title/author/state stay fresh
    // even when headSha hasn't changed (label-only or title-only updates).
    // Preserve existing labels from the index (getPullRequest doesn't return them).
    const prevLabels = prIndex.get(prId)?.labels;
    await prIndex.upsert({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.user?.login ?? "",
      labels: prevLabels ?? [],
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      mergedAt: pr.merged_at,
      headSha: pr.head.sha,
      htmlUrl: pr.html_url,
      draft: pr.draft,
    });

    // Check disk cache — skip file re-fetch if headSha hasn't changed
    const cached = await loadCachedPRFile(prId);
    if (cached && cached.headSha === headSha) {
      return;
    }

    await cachePRFiles(client, prId, headSha);
    await rebuildRelation();
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 404 || status === 410) {
      // Deterministic: the PR is gone — drop the stale cache entry.
      _logger?.warn({ prId, err: String(e) }, "pr-relations-cache: PR 不存在，删除缓存");
      await removeCachedPR(prId);
      await rebuildRelation();
      return;
    }
    // Transient failure (rate limit / 5xx / network): keep the stale cache
    // so reads still work, and surface the error so callers count it as failed.
    _logger?.error({ prId, err: String(e) }, "pr-relations-cache: 获取 PR 信息失败，保留缓存");
    throw e;
  }
}

// ─── Query API ──────────────────────────────────────────────────────

/**
 * Get a read-only view of the current relation map.
 */
export function getRelation(): ReadonlyMap<string, ReadonlySet<PRRelationEntry>> {
  return relation;
}

/**
 * Get relations for a specific PR. Returns mods where other PRs also touch
 * the same slug.
 */
export function getRelationsForPR(
  prId: number,
): Array<{
  slug: string;
  version: string;
  others: PRRelationEntry[];
}> {
  const results: Array<{
    slug: string;
    version: string;
    others: PRRelationEntry[];
  }> = [];

  for (const [slug, entries] of relation) {
    const myEntries = [...entries].filter((e) => e.prNumber === prId);
    const otherEntries = [...entries].filter((e) => e.prNumber !== prId);

    if (myEntries.length === 0 || otherEntries.length === 0) continue;

    for (const mine of myEntries) {
      results.push({
        slug,
        version: mine.version,
        others: otherEntries,
      });
    }
  }

  return results;
}
