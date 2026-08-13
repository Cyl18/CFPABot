// src/store.ts
// File-based data store: sessions, executions, PR state.

import type { FileStore, Logger } from "./types.js";
import { dirname } from "node:path";
import { appendFile, readdir, mkdir } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "./_shared/fs-utils.js";

// Per-file write queue for NDJSON append — prevents concurrent write interleaving on Windows.
const writeQueues = new Map<string, Promise<void>>();

/** Maximum number of pending write queue entries before evicting oldest. */
const WRITE_QUEUE_MAX = 500;

// ─── FileStore factory ──────────────────────────────────────────────────

export function createFileStore(logger?: Logger): FileStore {
  return {
    async read<T>(path: string): Promise<T | null> {
      // 复用 fs-utils:JSON 解析 + 缺失/损坏文件返回 null
      return readJsonFile<T>(path);
    },


    async write<T>(path: string, data: T): Promise<void> {
      // 复用 fs-utils:原子写 + Windows EPERM/EBUSY rename 重试
      await writeJsonFile(path, data);
    },

    async append<T>(path: string, line: T): Promise<void> {
      const content = JSON.stringify(line) + "\n";
      const prev = writeQueues.get(path) ?? Promise.resolve();
      const next = prev
        .catch(() => undefined)  // swallow previous error, keep queue moving
        .then(async () => {
          try {
            await appendFile(path, content, "utf-8");
          } catch (err: unknown) {
            // Create parent dir on ENOENT and retry once (Bun.write does this
            // automatically; appendFile should be consistent)
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              const dir = dirname(path);
              if (dir) await mkdir(dir, { recursive: true });
              await appendFile(path, content, "utf-8");
              return;
            }
            throw err;
          }
        })
        .finally(() => {
          if (writeQueues.get(path) === next) writeQueues.delete(path);
        });
      writeQueues.set(path, next);
      // Evict oldest entry if map grows too large (safety net for paths that receive
      // rapid appends where a newer promise already replaced this entry before
      // the queue cleanup above ran)
      if (writeQueues.size > WRITE_QUEUE_MAX) {
        const oldest = writeQueues.keys().next().value;
        if (oldest !== undefined) writeQueues.delete(oldest);
      }
      return next;
    },

    async list(prefix: string): Promise<string[]> {
      try {
        const entries = await readdir(prefix);
        return entries;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return [];
        logger?.warn({ err: String(err), prefix }, "store.list: readdir failed，返回空列表");
        return [];
      }
    },
  };
}
