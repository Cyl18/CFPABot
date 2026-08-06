// src/cron-tasks/pr-cache-refresh.ts
// Cron task: auto-refresh PR cache via the pr_cache_refresh Flow (executeFlow).
//
// Runs every 4 hours. Defaults to incremental (watermark-based, early-stop)
// which is cheap (1–3 API pages when nothing changed).  Once every 24 hours
// a full refresh runs to clean closed-PR stale cache entries.

import { executeFlow } from "@/engine/execute.js";
import type { CronTask } from "@/cron.js";
import type { FlowContext } from "@/types.js";
import type { CronTaskDeps } from "./index.js";
import { lastFullRefreshAt, isPrCacheRefreshInFlight } from "@/client/pr-relations-cache.js";

const FOUR_HOURS_MS = 4 * 3600_000;
const TWENTY_FOUR_HOURS_MS = 24 * 3600_000;

/** Create the pr-cache-refresh cron task. */
export function createPrCacheRefreshTask(
  deps: CronTaskDeps,
  ctxFactory: () => FlowContext,
): CronTask {
  return {
    name: "pr-cache-refresh",
    intervalMs: FOUR_HOURS_MS,
    // Skip when a list+refresh pipeline is already in flight (init or a forced full).
    // Do NOT skip based on time — incremental is cheap and runs every cycle
    // when the system is idle.
    shouldSkip: async () => isPrCacheRefreshInFlight(),
    run: async () => {
      // Force full refresh every 24h for stale-cache cleanup
      const forceFull = lastFullRefreshAt === null || Date.now() - lastFullRefreshAt >= TWENTY_FOUR_HOURS_MS;
      deps.logger.info({ forceFull }, "cron pr-cache-refresh: 开始");

      const flow = deps.registry.get("pr_cache_refresh");
      const ctx = ctxFactory();

      await executeFlow(flow, ctx, { mode: "all", force: forceFull });
    },
  };
}
