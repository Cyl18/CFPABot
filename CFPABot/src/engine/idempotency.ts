// src/engine/idempotency.ts
// Business idempotency: double-checked lock + concurrent dedup + persisted cache.

import crypto from "node:crypto";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import type { TSchema, Static } from "typebox";
import { IDEMPOTENCY_DIR } from "../runtime-paths.js";
import { decodeOrThrow } from "./validate.js";
import { ensureFlowError } from "./timeout.js";
import { appendRecord, buildRecord } from "./record.js";
import { executeWithRetry } from "./retry.js";
import { removeFile } from "../_shared/fs-utils.js";

/** Deterministic collision-free filesystem-safe encoding for idempotency
 *  keys. SHA-256 hex produces a fixed 64-character lowercase hex string
 *  regardless of key length or content (no Windows filesystem collisions). */
export function safeIdempKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf-8").digest("hex");
}

export function idempotencyPath(key: string): string {
  return `${IDEMPOTENCY_DIR}/${safeIdempKey(key)}.json`;
}

/** In-process per-key deduplication: when two callers race on the same
 *  idempotency key, the second waits for the first to finish and then
 *  reads the cached result — avoiding duplicate execution. */
export const inflightIdempotent = new Map<string, Promise<unknown>>();

export async function executeWithIdempotency<
  InputSchema extends TSchema,
  OutputSchema extends TSchema,
>(
  idempKey: string,
  executionId: string,
  ctx: FlowContext,
  flow: Flow<InputSchema, OutputSchema>,
  decodedInput: Static<InputSchema>,
  startedAt: number,
  startedAtIso: string,
  resolvedRetry: { maxAttempts: number; backoffMs: number } | null,
): Promise<Static<OutputSchema>> {
  // Fast path: already persisted from a prior run.
  const cached = await ctx.store.read<unknown>(idempotencyPath(idempKey));
  if (cached !== null) {
    // Validate cached output before returning — corrupt cache must not
    // silently produce invalid results. Corrupted entries are dropped and
    // re-executed below (deterministic idempotency keys would otherwise
    // hit the corrupt entry forever).
    const validated = validateCachedOutput(flow, cached, executionId, ctx, decodedInput, startedAt, startedAtIso, idempKey);
    if (validated !== null) {
      await appendRecord(ctx, buildRecord(ctx, flow, executionId, decodedInput, validated, null, undefined, startedAt, startedAtIso, true));
      return validated;
    }
  }

  // Concurrency guard: deduplicate concurrent callers for this key.
  const existing = inflightIdempotent.get(idempKey);
  if (existing) {
    await existing; // wait for first caller
    // First caller wrote to store — read it.
    const stored = await ctx.store.read<unknown>(idempotencyPath(idempKey));
    const raw = stored ?? (await existing);
    const validated = validateCachedOutput(flow, raw, executionId, ctx, decodedInput, startedAt, startedAtIso, idempKey);
    if (validated !== null) {
      await appendRecord(ctx, buildRecord(ctx, flow, executionId, decodedInput, validated, null, undefined, startedAt, startedAtIso, true));
      return validated;
    }
  }

  // First caller: execute under the lock.
  const ourPromise = (async (): Promise<Static<OutputSchema>> => {
    // Double-check under lock (another caller may have written between our
    // fast-path read and acquiring the slot).
    const reChecked = await ctx.store.read<unknown>(idempotencyPath(idempKey));
    if (reChecked !== null) {
      const validated = validateCachedOutput(flow, reChecked, executionId, ctx, decodedInput, startedAt, startedAtIso, idempKey);
      if (validated !== null) return validated;
      // Corrupted → fall through and re-execute.
    }

    const decodedOutput = await executeWithRetry(
      executionId, ctx, flow, decodedInput, startedAt, startedAtIso, resolvedRetry,
    );
    // Persist (best-effort: write failure does not fail the flow)
    await ctx.store.write(idempotencyPath(idempKey), decodedOutput).catch((err) => {
      ctx.logger.warn({ err: String(err), flow: flow.name, idempKey }, "Idempotency cache write failed — continuing without persistence");
    });
    return decodedOutput;
  })();

  inflightIdempotent.set(idempKey, ourPromise);
  try {
    return await ourPromise;
  } finally {
    if (inflightIdempotent.get(idempKey) === ourPromise) {
      inflightIdempotent.delete(idempKey);
    }
  }
}

/** Validate a cached idempotency result against the output schema.
 *  Returns the validated output, or null (and deletes the corrupt entry)
 *  when the cache is damaged — the caller re-executes instead of failing.
 *  Deterministic idempotency keys (deliveryId-derived) make a permanent
 *  corrupt entry a hard failure for that delivery, so it must be evicted. */
export function validateCachedOutput<
  InputSchema extends TSchema,
  OutputSchema extends TSchema,
>(
  flow: Flow<InputSchema, OutputSchema>,
  raw: unknown,
  executionId: string,
  ctx: FlowContext,
  decodedInput: Static<InputSchema>,
  startedAt: number,
  startedAtIso: string,
  idempKey: string,
): Static<OutputSchema> | null {
  try {
    return decodeOrThrow(flow.output, raw, "output");
  } catch {
    ctx.logger.warn(
      { flow: flow.name, idempKey },
      "幂等缓存条目损坏，删除并重新执行",
    );
    void removeFile(idempotencyPath(idempKey)).catch(() => {
      // Best-effort eviction — if the delete fails the next attempt hits the
      // same corrupt entry and retries eviction.
    });
    return null;
  }
}
