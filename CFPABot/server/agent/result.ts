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

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  nextOffset: number | null;
}

/** 给资源加 ?offset=&limit=；截断时给出 nextOffset，模型不必再猜怎么翻页。 */
export function paginate<T>(items: readonly T[], query: URLSearchParams, max = 100, defaultLimit = 50): Page<T> {
  const rawOffset = query.get("offset");
  const rawLimit = query.get("limit");
  const page = pageOf(
    rawOffset === null ? undefined : Number(rawOffset),
    rawLimit === null ? undefined : Number(rawLimit),
    max,
    defaultLimit,
  );
  const slice = items.slice(page.offset, page.offset + page.limit);
  const end = page.offset + slice.length;
  const nextOffset = end < items.length ? end : null;
  return { items: slice, total: items.length, offset: page.offset, limit: page.limit, truncated: nextOffset !== null, nextOffset };
}
