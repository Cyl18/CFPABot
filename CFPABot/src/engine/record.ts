// src/engine/record.ts
// NDJSON execution record writing.

import type { Flow, FlowContext } from "@/types.js";
import { type ExecutionRecord } from "@/types.js";
import { EXECUTIONS_DIR } from "../runtime-paths.js";

const NDJSON_DIR = EXECUTIONS_DIR;

// ─── Sensitive-field redaction ─────────────────────────────────────────
// Flow inputs occasionally carry credentials (e.g. user OAuth tokens in
// modlist_get/modlist_build). NDJSON execution records are written to disk
// verbatim, so redact any field whose key looks like a secret before
// persisting — logs/backups must never contain live credentials.

const SENSITIVE_KEY_RE = /(token|secret|api[_-]?key|password|authorization|pem)/i;

function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function executionFilePath(ctx: FlowContext): string {
  const pr = ctx.scope.prNumber;
  return `${NDJSON_DIR}/${pr != null ? pr : 'none'}.ndjson`;
}

export function buildRecord(
  ctx: FlowContext,
  flow: Flow,
  executionId: string,
  input: unknown,
  output: unknown,
  error: string | null,
  errorCode: string | undefined,
  startedAt: number,
  startedAtIso: string,
  replayed = false,
): ExecutionRecord {
  const finishedAt = Date.now();
  return {
    flow_name: flow.name,
    execution_id: executionId,
    input: redactSensitive(input),
    output: redactSensitive(output),
    started_at: startedAtIso,
    finished_at: new Date(finishedAt).toISOString(),
    error,
    error_code: errorCode,
    duration_ms: finishedAt - startedAt,
    replayed: replayed || undefined,
    invocation_source: ctx.invocation.source,
    invocation_id: ctx.invocation.id,
    parent_id: ctx.invocation.parentId,
    session_id: ctx.invocation.sessionId,
    delivery_id: ctx.invocation.deliveryId,
  };
}

export async function appendRecord(
  ctx: FlowContext,
  record: ExecutionRecord,
): Promise<void> {
  try {
    await ctx.store.append(executionFilePath(ctx), record);
  } catch (err) {
    ctx.logger.warn(
      { err: String(err), flow: record.flow_name },
      "执行记录写入失败",
    );
  }
}
