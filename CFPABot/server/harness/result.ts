import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

/** JSON 结果必须守住 omp 的 50 KiB 截断线 */
export const RESULT_BUDGET_BYTES = 45_000;

export interface OversizeGuide {
  hint?: string;
  next?: string[];
}

function envelope(bytes: number, guide: OversizeGuide, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "结果超过单次读取预算，未返回残缺数据",
          bytes,
          budgetBytes: RESULT_BUDGET_BYTES,
          ...(guide.hint === undefined ? {} : { hint: guide.hint }),
          ...(guide.next === undefined ? {} : { next: guide.next }),
        }),
      },
    ],
    details: { ...details, oversized: true, bytes },
    isError: true,
  };
}

export function jsonResult(
  value: unknown,
  details: Record<string, unknown> = {},
  guide: OversizeGuide = {},
): AgentToolResult<Record<string, unknown>> {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > RESULT_BUDGET_BYTES) {
    return envelope(bytes, { hint: "缩小过滤范围，或用 limit/offset 分页后重试", ...guide }, details);
  }
  return { content: [{ type: "text", text }], details };
}

export interface ToolFailure extends AgentToolResult<Record<string, unknown>> {
  isError: true;
}

/** 写入被校验拦下时，把可行动的错误原样交给模型，而不是抛成一段无结构文本。 */
export function errorResult(value: unknown): ToolFailure {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: {}, isError: true };
}

export function textResult(
  text: string,
  details: Record<string, unknown> = {},
  guide: OversizeGuide = {},
  options: { clip?: boolean } = {},
): AgentToolResult<Record<string, unknown>> {
  const bytes = Buffer.byteLength(text);
  if (options.clip === false || bytes <= RESULT_BUDGET_BYTES) return { content: [{ type: "text", text }], details };
  const notice = `\n…[已截断：原 ${bytes} B，改用行范围或更窄的过滤条件读取${guide.hint === undefined ? "" : `；${guide.hint}`}]`;
  const clipped = Buffer.from(text).subarray(0, RESULT_BUDGET_BYTES - Buffer.byteLength(notice)).toString("utf8");
  return {
    content: [{ type: "text", text: clipped + notice }],
    details: { ...details, truncated: true, bytes },
  };
}

export function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  return {
    items: slice,
    total: items.length,
    offset: page.offset,
    limit: page.limit,
    truncated: nextOffset !== null,
    nextOffset,
  };
}

/** 只取调用方点名的段，避免模型一次拿到全部再自己剪。 */
export function pickFields<T extends object>(value: T, query: URLSearchParams): Partial<T> {
  const fields = query.get("fields");
  if (fields === null || fields.trim() === "") return value;
  const wanted = new Set(fields.split(",").map((field) => field.trim()).filter(Boolean));
  return Object.fromEntries(Object.entries(value).filter(([key]) => wanted.has(key))) as Partial<T>;
}
