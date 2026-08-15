// src/agent/flow-adapter.ts
// Flow -> ToolDefinition conversion for pi-coding-agent.
// Uses Flow.input (TypeBox schema) as the sole parameter schema.
// All executions go through executeFlow().
// PR-scoped input conflicts, structured errors, and risk-based confirmation.
// For repository_write/destructive with no SessionService: hard CONFIRMATION_REQUIRED error.
// With SessionService: pending-promise rendezvous — adapter awaits confirmation.

import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { requiresAgentConfirmation } from "@/engine/policy.js";
import { executeFlow } from "@/engine/execute.js";
import type { SessionService } from "./session-service.js";
import { computeInputHash } from "./session-service.js";
import type { ToolResult } from "./session-service.js";

function extractPrNumber(params: unknown): number | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const val = (p.prNumber as number | undefined) ?? (p.prId as number | undefined);
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function extractBaseSha(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const val = p.baseSha;
  return typeof val === "string" ? val : undefined;
}

function extractHeadSha(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const val = p.headSha;
  return typeof val === "string" ? val : undefined;
}

/**
 * Convert a Flow to a pi-coding-agent ToolDefinition with full lifecycle.
 *
 * PR scope validation: if ctx.scope has a prNumber/baseSha/headSha,
 * the tool checks that the corresponding parameters either match or
 * are omitted by the LLM (no cross-session escape).
 *
 * Risk-based confirmation via SessionService:
 * - read / review_write: auto-executes (no confirmation).
 * - repository_write / destructive: registers a pending confirmation and
 *   blocks via SessionService.  The admin MUST confirm via the REST API
 *   before the thunk executes.  Rejection produces a structured non-retryable
 *   error in the tool result.
 *
 * ExtensionContext is unused (CFPABot has no extension system).
 */
export function flowToToolDefinition(
  flow: Flow,
  ctx: FlowContext,
  sessionService?: SessionService,
  sessionId?: string,
): ToolDefinition {
  return {
    name: flow.name,
    label: flow.description,
    description: flow.description,
    parameters: flow.input,
    execute: async (toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) => {
      // ── PR scope validation — every supplied field checked ────────
      const scope = ctx.scope;
      if (scope.prNumber !== undefined) {
        const paramPr = extractPrNumber(params);
        if (paramPr !== undefined && paramPr !== scope.prNumber) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `PR 编号冲突: 会话固定为 PR #${scope.prNumber}，但工具输入指定了 PR #${paramPr}。`,
              code: "SCOPE_VIOLATION",
            })}],
            details: { code: "SCOPE_VIOLATION" },
          };
        }
      }
      if (scope.baseSha !== undefined) {
        const paramBase = extractBaseSha(params);
        if (paramBase !== undefined && paramBase !== scope.baseSha) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `base SHA 冲突: 会话固定为 ${scope.baseSha.slice(0, 7)}，但工具输入指定了 ${paramBase.slice(0, 7)}。`,
              code: "SCOPE_VIOLATION",
            })}],
            details: { code: "SCOPE_VIOLATION" },
          };
        }
      }
      if (scope.headSha !== undefined) {
        const paramHead = extractHeadSha(params);
        if (paramHead !== undefined && paramHead !== scope.headSha) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `head SHA 冲突: 会话固定为 ${scope.headSha.slice(0, 7)}，但工具输入指定了 ${paramHead.slice(0, 7)}。`,
              code: "SCOPE_VIOLATION",
            })}],
            details: { code: "SCOPE_VIOLATION" },
          };
        }
      }

      // ── Risk-based confirmation (shared policy module) ─────────────
      const risk = flow.meta.risk;
      const needsConfirmation = requiresAgentConfirmation(risk);

      if (needsConfirmation) {
        if (!sessionService || !sessionId) {
          // No session service: hard error, never auto-execute
          throw new FlowError({
            code: "CONFIRMATION_REQUIRED",
            message: `Flow "${flow.name}" (${risk}) requires an agent session for confirmation.`,
            publicMessage: `操作 "${flow.name}" 风险较高 (${risk})，请在 Agent 会话中使用。`,
            retryable: false,
          });
        }

        const inputHash = await computeInputHash(params);

        // Register pending and await confirmation/rejection
        // This blocks the tool call until the admin resolves it
return sessionService.registerAndAwaitConfirmation(
          sessionId,
          toolCallId,
          flow.name,
          params,
          inputHash,
          (abortSignal) => doExecute(flow, ctx, params, signal, toolCallId, abortSignal),
        );
      }

      // ── Low risk: execute directly ────────────────────────────────
      return doExecute(flow, ctx, params, signal, toolCallId);
    },
  };
}
async function doExecute(
  flow: Flow,
  ctx: FlowContext,
  params: unknown,
  signal: AbortSignal | undefined,
  toolCallId: string,
  sessionAbort?: AbortSignal,
): Promise<ToolResult> {
  const effectiveSignal = signal
    ? composeAbortSignals(ctx.signal, signal)
    : ctx.signal;
  const flowCtx: FlowContext = {
    ...ctx,
    // Agent-scope calls have no deliveryId — derive a deterministic
    // invocation id from session + tool call so retrying the same tool call
    // (agent retry, network uncertainty) hits the idempotency cache instead
    // of re-executing the side-effect flow.
    invocation: ctx.invocation.deliveryId
      ? ctx.invocation
      : {
          ...ctx.invocation,
          id: `${ctx.invocation.sessionId ?? "agent"}:${toolCallId}`,
        },
    signal: sessionAbort
      ? composeAbortSignals(effectiveSignal, sessionAbort)
      : effectiveSignal,
  };

  try {
    const result = await executeFlow(flow, flowCtx, params);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  } catch (err) {
    const flowErr = err instanceof FlowError
      ? err
      : new FlowError({ code: "FAILED", message: String(err), retryable: false });
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: flowErr.publicMessage,
        code: flowErr.code,
        retryable: flowErr.retryable,
      })}],
      details: { error: flowErr.publicMessage, code: flowErr.code, retryable: flowErr.retryable },
    };
  }
}

function composeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}

