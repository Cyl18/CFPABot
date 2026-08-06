// src/cron-tasks/cleanup.ts
// Cron task: periodic cleanup of stale executions, idempotency keys, and sessions.
// Infrastructure-only — does not use executeFlow (no Flow definition needed).

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CronTask } from "@/cron.js";
import type { Logger } from "@/types.js";
import {
  EXECUTIONS_DIR,
  IDEMPOTENCY_DIR,
  SESSIONS_DIR,
  SESSIONS_TRANSCRIPTS_DIR,
} from "../runtime-paths.js";

const DAY_MS = 86_400_000;

/** Delete entries in a directory older than maxAgeMs. Returns count deleted. */
async function cleanupDir(
  dirPath: string,
  maxAgeMs: number,
  logger: Logger,
  opts?: { fileOnly?: boolean; matchExt?: string },
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return 0; // directory may not exist yet
  }

  const now = Date.now();
  let deleted = 0;
  for (const entry of entries) {
    const filePath = join(dirPath, entry);
    try {
      if (opts?.matchExt && !entry.endsWith(opts.matchExt)) continue;
      const fileStat = await stat(filePath);
      if (opts?.fileOnly && !fileStat.isFile()) continue;
      if (now - fileStat.mtimeMs > maxAgeMs) {
        await rm(filePath, { recursive: true, force: true });
        deleted++;
      }
    } catch (err) {
      logger.warn({ filePath, err: String(err) }, "cleanup: 删除失败，跳过");
    }
  }
  return deleted;
}


/** Create the cleanup cron task. */
export function createCleanupTask(logger: Logger): CronTask {
  return {
    name: "cleanup",
    intervalMs: 24 * 3600_000, // daily
    run: async () => {
      logger.info({}, "cleanup: 开始保留清理");

      const executionsDeleted = await cleanupDir(EXECUTIONS_DIR, 30 * DAY_MS, logger);
      const idempotencyDeleted = await cleanupDir(IDEMPOTENCY_DIR, 30 * DAY_MS, logger);
      // Sessions: only delete top-level *.json, never _dedup/ or transcripts/.
      const sessionsDeleted = await cleanupDir(SESSIONS_DIR, 90 * DAY_MS, logger, {
        fileOnly: true,
        matchExt: ".json",
      });
      const transcriptDeleted = await cleanupDir(SESSIONS_TRANSCRIPTS_DIR, 90 * DAY_MS, logger, {
        fileOnly: true,
        matchExt: ".jsonl",
      });

      logger.info(
        { executionsDeleted, idempotencyDeleted, sessionsDeleted, transcriptDeleted },
        "cleanup: 保留清理完成",
      );
    },
  };
}
