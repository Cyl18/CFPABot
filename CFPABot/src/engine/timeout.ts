// src/engine/timeout.ts
// Combined AbortSignal + Promise.race timeout with cleanup.

import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import type { TSchema, Static } from "typebox";
import { runWithRequestSignal } from "../client/request-context.js";

export async function runWithTimeout<
  InputSchema extends TSchema,
  OutputSchema extends TSchema,
>(
  ctx: FlowContext,
  flow: Flow<InputSchema, OutputSchema>,
  decodedInput: Static<InputSchema>,
): Promise<Static<OutputSchema>> {
  const combinedController = new AbortController();
  const cleanup: (() => void)[] = [];

  // Wire parent cancellation
  if (ctx.signal.aborted) {
    throw new FlowError({
      code: "FAILED",
      message: "Flow cancelled before execution",
      retryable: false,
    });
  }
  const onParentAbort = () => combinedController.abort(ctx.signal.reason);
  ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  cleanup.push(() => ctx.signal.removeEventListener("abort", onParentAbort));

  // Wire timeout
  const timeoutMs = flow.meta.timeoutMs;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      combinedController.abort(
        new FlowError({
          code: "TIMEOUT",
          message: `Flow "${flow.name}" timed out after ${timeoutMs}ms`,
          retryable: true,
        }),
      );
    }, timeoutMs);
    cleanup.push(() => clearTimeout(timeoutId));
  }

  // Build execution context whose signal is the combined (timeout + parent)
  // signal, so the flow implementation sees cancellations from either source.
  const execCtx: FlowContext = { ...ctx, signal: combinedController.signal };

  try {
    // Build a promise that rejects when the combined signal fires.
    const { promise: cancelPromise, reject: cancelReject } = Promise.withResolvers<Static<OutputSchema>>();
    if (combinedController.signal.aborted) {
      cancelReject(
        combinedController.signal.reason ??
          new FlowError({ code: "FAILED", message: "Flow cancelled", retryable: false }),
      );
    } else {
      combinedController.signal.addEventListener(
        "abort",
        () => {
          cancelReject(
            combinedController.signal.reason ??
              new FlowError({ code: "FAILED", message: "Flow cancelled", retryable: false }),
          );
        },
        { once: true },
      );
    }

    return await Promise.race([
      runWithRequestSignal(combinedController.signal, () => flow.execute(execCtx, decodedInput)),
      cancelPromise,
    ]);
  } catch (raw) {
    throw ensureFlowError(raw);
  } finally {
    for (const fn of cleanup) fn();
  }
}

/** Wrap any thrown value into a FlowError. */
export function ensureFlowError(raw: unknown): FlowError {
  if (raw instanceof FlowError) return raw;
  return new FlowError({
    code: "FAILED",
    message: String(raw),
    retryable: false,
    details: { originalError: String(raw) },
  });
}
