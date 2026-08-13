// src/cron-tasks/curseforge-mapping.ts
// Cron task: refresh CurseForge slug -> project ID mapping via the mapping_refresh Flow.

import { executeFlow } from "@/engine/execute.js";
import type { CronTask } from "@/cron.js";
import type { FlowContext } from "@/types.js";
import type { CronTaskDeps } from "./index.js";

import { MAPPING_PATH } from "../runtime-paths.js";
/** Create the curseforge-mapping cron task. */
export function createCurseforgeMappingTask(
  deps: CronTaskDeps,
  ctxFactory: () => FlowContext,
): CronTask {
  return {
    name: "curseforge-mapping",
    intervalMs: 7 * 24 * 60 * 60_000, // 7 days
    shouldSkip: async () => {
      const intervalMs = 7 * 24 * 60 * 60_000;
      try {
        const file = Bun.file(MAPPING_PATH);
        const exists = await file.exists();
        if (!exists) return false;
        const stat = await file.stat();
        const ageMs = Date.now() - stat.mtimeMs;
        return ageMs < intervalMs;
      } catch (e) {
        deps.logger.warn({ err: String(e) }, "cron curseforge-mapping: shouldSkip 检查失败，将继续运行");
      }
      return false;
    },
    run: async () => {
      if (!process.env.CF_API_KEY) {
        deps.logger.warn({}, "cron curseforge-mapping: CF_API_KEY 未设置，跳过");
        return;
      }

      deps.logger.info({}, "cron curseforge-mapping: 开始通过 executeFlow 刷新");

      const flow = deps.registry.get("mapping_refresh");
      const ctx = ctxFactory();

      await executeFlow(flow, ctx, { force: false });
    },
  };
}
