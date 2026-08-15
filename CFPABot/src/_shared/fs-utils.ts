// src/_shared/fs-utils.ts
// Durable-JSON primitives for cache I/O (atomic writes + Windows EPERM retry).
// Project-level shared infrastructure (has I/O + process-level locking),
// distinct from flows/_shared/ (pure algorithms).
//
// ─── Convention: all runtime JSON cache writes go through this module ─────
// Every persistence of runtime/cache/*.json files — whether from client/,
// flows/_internal/, or cron-tasks/ — MUST use writeJsonFile or writeJsonLocked
// (or a cache.ts helper that wraps one of them).  Never Bun.write runtime/cache/*
// directly: bare writes lose the atomic-rename and Windows-retry guarantees.
//
// Sessions and execution records (runtime/sessions/, runtime/ops/executions/) use
// store.ts FileStore — a different concern (NDJSON append, not JSON overwrite).
//
// writeJsonLocked is preferred for shared multi-writer paths (cron + API both
// touching the same file); writeJsonFile is appropriate when the caller already
// serializes access.

import { mkdir, rename, unlink, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireLock } from "@/engine/lock.js";

// ─── Retry helper for Windows EPERM/EBUSY on rename ─────────────────
// On Windows, rename() (MoveFileExW with MOVEFILE_REPLACE_EXISTING) can
// fail with EPERM or EBUSY if antivirus or the search indexer holds a
// transient handle on the destination file.  Bounded retry preserves
// atomic-write semantics without gaps.

const RENAME_RETRY_MAX = 3;
const RENAME_RETRY_BASE_MS = 50;

async function renameWithRetry(source: string, dest: string): Promise<void> {
  let lastErr: NodeJS.ErrnoException | undefined;
  for (let attempt = 1; attempt <= RENAME_RETRY_MAX; attempt++) {
    try {
      await rename(source, dest);
      return;
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException;
      // Non-retryable errors propagate immediately
      if (lastErr.code !== "EPERM" && lastErr.code !== "EBUSY") throw lastErr;
      if (attempt < RENAME_RETRY_MAX) {
        // Exponential-ish backoff: 50ms, 100ms, 150ms
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, RENAME_RETRY_BASE_MS * attempt);
        await promise;
      }
    }
  }
  // All retries exhausted — propagate the last error
  throw lastErr!;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Read a JSON file from disk.
 * Returns null if the file is missing or contains invalid JSON.
 * Never throws for missing or corrupt files.
 */
export async function readJsonFile<T>(
  path: string,
): Promise<T | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return (await file.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Atomically write a JSON file to disk.
 * Creates the parent directory if it does not exist.
 * Writes to a temporary file first, then renames with retry for
 * Windows EPERM/EBUSY resilience.  Cleans up the temp file on failure.
 */
export async function writeJsonFile(
  path: string,
  data: unknown,
  options?: { mode?: number },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${crypto.randomUUID()}`;
  try {
    await Bun.write(tmpPath, JSON.stringify(data, null, 2));
    if (options?.mode !== undefined) {
      await chmod(tmpPath, options.mode);
    }
    await renameWithRetry(tmpPath, path);
  } catch (err) {
    // Clean up temp file on failure; ignore ENOENT
    try {
      await unlink(tmpPath);
    } catch {
      // Temp file may not exist if Bun.write failed
    }
    throw err;
  }
}

/**
 * Run a function under a process-level named lock.
 * Acquires the lock before calling fn and releases it in a finally block.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(key);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Serialize writers for a path using a named lock, then perform an atomic
 * JSON write.  Default lock key is `json-write:${path}`.  Pass an explicit
 * `lockKey` to share a lock across multiple paths or use a custom name.
 */
export async function writeJsonLocked(
  path: string,
  data: unknown,
  lockKey?: string,
): Promise<void> {
  const key = lockKey ?? `json-write:${path}`;
  const release = await acquireLock(key);
  try {
    await writeJsonFile(path, data);
  } finally {
    release();
  }
}

/**
 * Remove a file from disk, ignoring ENOENT errors.
 * Throws on other errors (EACCES, EBUSY, etc.).
 */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
