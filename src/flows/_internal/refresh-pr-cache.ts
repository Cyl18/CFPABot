// src/flows/_internal/refresh-pr-cache.ts
// Cross-domain internal: refresh PR cache (list index + relation cache).
// Wraps the real logic from client/pr-relations-cache.ts.
// No Flow definition — called by the pr_cache_refresh Flow and by cron.
//
// refreshPrListCache updates BOTH the PR index (prIndex, via fullListAndRefresh)
// and the relation cache (per-PR file caches) from a single listAllPulls call.
// GET /prs reads only from prIndex — the index is the single source of truth
// for open PR summaries.
//
// Current callers:
// - pr_cache_refresh (src/flows/cache/pr_cache_refresh.ts)

import type { FlowContext } from "@/types.js";
import { FlowError } from "./types.js";
import {
  fullListAndRefresh,
  refreshRelation,
  removeCachedPR,
  readListWatermark,
  writeListWatermark,
  listChangedPrs,
  incrementalRefreshFromList,
} from "@/client/pr-relations-cache.js";

/** Result of a single PR cache operation. */
export interface PrCacheResult {
  refreshed: number;
  removed: number;
  failed: number;
}

/**
 * Refresh the PR relation cache.
 *
 * Default behaviour (full=false, watermark exists):
 *   Incremental: list with sort=updated&direction=desc + early-stop,
 *   only refresh PRs whose files changed. Does NOT clean closed-PR caches.
 *
 * When full=true or no watermark exists:
 *   Full: full list + batch refresh + stale cache cleanup + watermark advance.
 */
export async function refreshPrListCache(
  ctx: FlowContext,
  token?: string,
  full?: boolean,
): Promise<PrCacheResult> {
  let refreshed = 0;
  let removed = 0;
  let failed = 0;

  try {
    // ── Incremental path (default) ──
    if (!full) {
      const watermark = await readListWatermark();
      if (watermark) {
        const listResult = await listChangedPrs(ctx.github, watermark);
        if (listResult) {
          if (listResult.candidates.length > 0) {
            const batchResult = await incrementalRefreshFromList(ctx.github, listResult.candidates);
            refreshed = batchResult.refreshed;
            failed = batchResult.failed;
          }

          // Always advance watermark so we don't infinite-rescan the same PRs.
          // Failed PRs will be picked up on the next full cycle (every 24h).
          await writeListWatermark(listResult.newWatermark);

          ctx.logger.info(
            { candidates: listResult.candidates.length, refreshed, failed, newWatermark: listResult.newWatermark },
            "refreshPrListCache: incremental completed",
          );
          return { refreshed, removed: 0, failed };
        }
      }
    }

    // ── Full refresh path (uses coalesced fullListAndRefresh to avoid double-list) ──
    ctx.logger.info({ full: true }, "refreshPrListCache: 开始完整刷新");
    const batchResult = await fullListAndRefresh(ctx.github);
    refreshed = batchResult.refreshed;
    removed = batchResult.removed;
    failed = batchResult.failed;
    ctx.logger.info(
      { refreshed, removed, failed },
      "refreshPrListCache: full completed",
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ err: message }, "refreshPrListCache: failed");
    throw new FlowError({
      code: "FAILED",
      message,
      publicMessage: "Failed to refresh PR cache.",
      retryable: true,
    });
  }

  return { refreshed, removed, failed };
}

/**
 * Refresh a single PR's relation cache.
 */
export async function refreshSinglePrCache(
  ctx: FlowContext,
  prNumber: number,
): Promise<PrCacheResult> {
  try {
    await refreshRelation(ctx.github, prNumber);
    ctx.logger.info({ prNumber }, "refreshSinglePrCache: completed");
    return { refreshed: 1, removed: 0, failed: 0 };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ prNumber, err: message }, "refreshSinglePrCache: failed");
    return { refreshed: 0, removed: 0, failed: 1 };
  }
}

/**
 * Remove a closed PR from the local relation cache.
 */
export async function removeClosedFromPrCache(
  ctx: FlowContext,
  prNumber: number,
): Promise<PrCacheResult> {
  try {
    await removeCachedPR(prNumber);
    ctx.logger.info({ prNumber }, "removeClosedFromPrCache: completed");
    return { refreshed: 0, removed: 1, failed: 0 };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ prNumber, err: message }, "removeClosedFromPrCache: failed");
    return { refreshed: 0, removed: 0, failed: 1 };
  }
}
