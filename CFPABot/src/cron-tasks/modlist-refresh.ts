// src/cron-tasks/modlist-refresh.ts
// Cron task: refresh mod list via the modlist_refresh Flow (executeFlow).
// Uses a shallow clone under runtime/repo, updated via git fetch.

import { executeFlow } from "@/engine/execute.js";
import type { CronTask } from "@/cron.js";
import type { FlowContext } from "@/types.js";
import type { CronTaskDeps } from "./index.js";

/** Create the modlist-refresh cron task. */
export function createModlistRefreshTask(
  deps: CronTaskDeps,
  ctxFactory: () => FlowContext,
): CronTask {
  return {
    name: "modlist-refresh",
    intervalMs: 24 * 60 * 60_000,
    run: async () => {
      deps.logger.info({}, "cron modlist-refresh: 开始通过 executeFlow 刷新");

      const flow = deps.registry.get("modlist_refresh");
      const ctx = ctxFactory();

      // Cron never forces: webhooks should already have refreshed the cache on push,
      // so an unchanged HEAD is a genuine skip. force=false lets the flow short-circuit.
      await executeFlow(flow, ctx, { force: false });
    },
  };
}
