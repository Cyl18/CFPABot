import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function jsonResult(value: unknown, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details };
}

export function safePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error(`非法路径: ${path}`);
  return normalized;
}

export function pageOf(offset: number | undefined, limit: number | undefined, max: number, defaultLimit: number): { offset: number; limit: number } {
  const start = Math.max(0, Math.floor(offset ?? 0));
  return { offset: start, limit: Math.min(max, Math.max(1, Math.floor(limit ?? defaultLimit))) };
}
