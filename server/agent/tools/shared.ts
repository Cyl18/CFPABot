import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function jsonResult(value: unknown, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details };
}

export function pageOf(offset: number | undefined, limit: number | undefined, max: number, defaultLimit: number): { offset: number; limit: number } {
  const start = Math.max(0, Math.floor(offset ?? 0));
  return { offset: start, limit: Math.min(max, Math.max(1, Math.floor(limit ?? defaultLimit))) };
}
