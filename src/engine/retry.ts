// src/engine/retry.ts
// Retry configuration + exponential backoff execution with cancellation-aware sleep.

import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import type { TSchema, Static } from "typebox";
import { FLOW_BACKOFF_CAP_MS } from "@/constants.js";
import { runWithTimeout, ensureFlowError } from "./timeout.js";
import { decodeOrThrow } from "./validate.js";
import { appendRecord, buildRecord } from "./record.js";

interface ResolvedRetry {
  maxAttempts: number;
  backoffMs: number;
}

/** Validate and resolve the retry configuration. Returns the resolved
 *  config or throws INVALID_INPUT if the metadata is self-contradictory. */
export function resolveRetry(
  retry: { maxAttempts: number; backoffMs: number } | undefined,
  hasIdempotencyKey: boolean,
): ResolvedRetry | null {
  if (!retry) return null;
  if (retry.maxAttempts < 2) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `retry.maxAttempts (${retry.maxAttempts}) must be >= 2 when retry is configured`,
      retryable: false,
    });
  }
  if (retry.backoffMs < 1) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `retry.backoffMs (${retry.backoffMs}) must be >= 1`,
      retryable: false,
    });
  }
  if (!hasIdempotencyKey) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "retry configured without idempotencyKey — retry requires idempotency for safe replay",
      retryable: false,
    });
  }
  return { maxAttempts: retry.maxAttempts, backoffMs: retry.backoffMs };
}

export async function executeWithRetry<
  InputSchema extends TSchema,
  OutputSchema extends TSchema,
>(
  executionId: string,
  ctx: FlowContext,
  flow: Flow<InputSchema, OutputSchema>,
  decodedInput: Static<InputSchema>,
  startedAt: number,
  startedAtIso: string,
  resolvedRetry: ResolvedRetry | null,
): Promise<Static<OutputSchema>> {
  const maxAttempts = resolvedRetry?.maxAttempts ?? 1;
  const backoffMs = resolvedRetry?.backoffMs ?? 0;

  let lastError: FlowError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await runWithTimeout(ctx, flow, decodedInput);
      const decodedOutput = decodeOrThrow(flow.output, output, "output");
      // Success — record outcome once
      await appendRecord(ctx, buildRecord(ctx, flow, executionId, decodedInput, decodedOutput, null, undefined, startedAt, startedAtIso));
      return decodedOutput;
    } catch (err) {
      const flowErr = ensureFlowError(err);

      // Decide whether to retry
      if (attempt < maxAttempts && flowErr.retryable) {
        lastError = flowErr;
        // Backoff with cancellation awareness
        const delay = Math.min(backoffMs * Math.pow(2, attempt - 1), FLOW_BACKOFF_CAP_MS);
        const slept = await sleepWithSignal(delay, ctx.signal);
        if (!slept) {
          // ctx.signal was aborted during sleep — record failure
          const cancelErr = new FlowError({
            code: "FAILED",
            message: `Flow cancelled during retry backoff after attempt ${attempt}`,
            retryable: false,
          });
          await appendRecord(ctx, buildRecord(ctx, flow, executionId, decodedInput, null, cancelErr.message, cancelErr.code, startedAt, startedAtIso));
          throw cancelErr;
        }
        continue; // retry
      }

      // Non-retryable or last attempt — record failure and throw
      await appendRecord(ctx, buildRecord(ctx, flow, executionId, decodedInput, null, flowErr.message, flowErr.code, startedAt, startedAtIso));
      throw flowErr;
    }
  }

  // Should never reach here (loop always throws or returns), but satisfy TS.
  throw lastError ?? new FlowError({ code: "FAILED", message: "Retry exhausted unexpectedly", retryable: false });
}

/** Sleep for `ms` milliseconds, returning false if ctx.signal aborts. */
export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  if (signal.aborted) {
    resolve(false);
    return promise;
  }
  const timer = setTimeout(() => resolve(true), ms);
  const onAbort = () => {
    clearTimeout(timer);
    resolve(false);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // 两条路径都清理监听器:定时器正常到期时不移除的话,长生命周期
  // signal(agent 会话级)会在每次重试退避时泄漏一个监听器。
  return promise.finally(() => signal.removeEventListener("abort", onAbort));
}
