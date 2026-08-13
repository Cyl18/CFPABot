// src/engine/execute.ts
// Production-only unified Flow execution entry — orchestrates validation,
// risk policy, idempotency, retry, timeout, and NDJSON telemetry.

import crypto from "node:crypto";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import type { TSchema, Static } from "typebox";

import { decodeOrThrow } from "./validate.js";
import { ensureFlowError } from "./timeout.js";
import { resolveRetry, executeWithRetry } from "./retry.js";
import { executeWithIdempotency } from "./idempotency.js";
import { appendRecord, buildRecord } from "./record.js";

// ─── executeFlow ─────────────────────────────────────────────────────

/**
 * Execute a Flow with full lifecycle management:
 *  1. TypeBox input validation
 *  2. Retry metadata validation
 *  3. Risk policy enforcement (destructive blocked for non-agent)
 *  4. Business idempotency check (FileStore-backed, double-checked locking)
 *  5. Retry loop (only when configured + idempotent)
 *  6. Timeout via combined AbortSignal (caller signal + timeoutMs)
 *  7. TypeBox output validation
 *  8. Idempotency result save
 *  9. Single NDJSON execution record per logical invocation
 *
 * Returns exactly `Static<OutputSchema>` — no envelope.
 * Throws `FlowError` for all structured failures.
 */
export async function executeFlow<
  InputSchema extends TSchema,
  OutputSchema extends TSchema,
>(
  flow: Flow<InputSchema, OutputSchema>,
  ctx: FlowContext,
  input: Static<InputSchema>,
): Promise<Static<OutputSchema>> {
  const executionId = crypto.randomUUID();
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();

  // ── 1. Input validation (failure path writes record) ─────────────
  let decodedInput: Static<InputSchema>;
  try {
    decodedInput = decodeOrThrow(flow.input, input, "input");
  } catch (err) {
    const flowErr = ensureFlowError(err);
    await appendRecord(ctx, buildRecord(ctx, flow, executionId, null, null, flowErr.message, flowErr.code, startedAt, startedAtIso));
    throw flowErr;
  }

  // ── 2. Resolve retry config ──────────────────────────────────────
  const hasIdempKey = !!flow.meta.idempotencyKey;
  const resolvedRetry = resolveRetry(flow.meta.retry, hasIdempKey);

  // ── 3. Risk policy ───────────────────────────────────────────────
  if (flow.meta.risk === "destructive" && ctx.invocation.source !== "agent") {
    const err = new FlowError({
      code: "CONFIRMATION_REQUIRED",
      message: `Flow "${flow.name}" (${flow.meta.risk}) requires agent invocation source`,
      retryable: false,
    });
    await appendRecord(ctx, buildRecord(ctx, flow, executionId, decodedInput, null, err.message, err.code, startedAt, startedAtIso));
    throw err;
  }

  // ── 4. Idempotency ──────────────────────────────────────────────
  const idempKey = flow.meta.idempotencyKey?.(ctx.invocation, decodedInput);
  if (idempKey) {
    return await executeWithIdempotency(
      idempKey, executionId, ctx, flow, decodedInput, startedAt, startedAtIso, resolvedRetry,
    );
  }

  // ── 5–9. No idempotency: execute (possibly with retry) ────────────
  return await executeWithRetry(
    executionId, ctx, flow, decodedInput, startedAt, startedAtIso, resolvedRetry,
  );
}
