import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

export function jsonResult(value: unknown, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details };
}

export function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}

export function pageOf(
  offset: number | undefined,
  limit: number | undefined,
  max: number,
  defaultLimit: number,
): { offset: number; limit: number } {
  const start = offset !== undefined && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const size =
    limit !== undefined && Number.isFinite(limit)
      ? Math.min(max, Math.max(1, Math.floor(limit)))
      : Math.min(max, Math.max(1, defaultLimit));
  return { offset: start, limit: size };
}
