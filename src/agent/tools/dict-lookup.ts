// src/agent/tools/dict-lookup.ts
// Custom tool: dict_lookup — P2 stub for dictionary backend.
//
// Three sources per business contract:
//   - agent_search: agent actively searched and stored via dict_lookup op=set
//   - forced_vanilla: P2 stub (reserved)
//   - internal: agent 从对齐数据识别术语后经 op=set source=internal 写入
//     （无自动抽取 —— 术语与否完全由 agent 判断）

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx, type Ctx, type DictEntry, type DictSource } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";

const VALID_SOURCES: DictSource[] = ["agent_search", "forced_vanilla", "internal", "ngram", "tm"];

export interface DictEntryInput {
  word: string;
  text: string;
  source?: DictSource;
  note?: string;
}

export interface DictLookupParams {
  op: "lookup" | "set" | "get";
  entries?: DictEntryInput[];
  query?: string[];
}

function isDictLookupParams(x: unknown): x is DictLookupParams {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (p.op === "set") return Array.isArray(p.entries);
  if (p.op === "lookup") return typeof p.query === "undefined" || Array.isArray(p.query);
  return p.op === "get";
}

function coerceEntry(item: unknown): DictEntry | null {
  if (!item || typeof item !== "object") return null;
  const e = item as DictEntryInput;
  if (typeof e.word !== "string" || typeof e.text !== "string") return null;
  const source = VALID_SOURCES.includes(e.source as DictSource)
    ? (e.source as DictSource)
    : "agent_search";
  return {
    word: e.word,
    text: e.text,
    source,
    ...(typeof e.note === "string" ? { note: e.note } : {}),
  };
}

export function createDictLookupTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    op: Type.Union([
      Type.Literal("lookup"),
      Type.Literal("set"),
      Type.Literal("get"),
    ], { description: "lookup=查词典（P2 stub 返回空）, set=写入 agent 收集条目, get=读 ctx.dict" }),
    entries: Type.Optional(
      Type.Array(
        Type.Object({
          word: Type.String({ description: "词条（英文原词）" }),
          text: Type.String({ description: "译文" }),
          source: Type.Optional(
            Type.Union([
              Type.Literal("agent_search"),
              Type.Literal("forced_vanilla"),
              Type.Literal("internal"),
              Type.Literal("ngram"),
              Type.Literal("tm"),
            ]),
          ),
          note: Type.Optional(Type.String()),
        }),
        { description: "op=set 时追加到 ctx.dict 的条目" },
      ),
    ),
    query: Type.Optional(
      Type.Array(Type.String(), { description: "op=lookup 时的查询词（P2 stub 忽略）" }),
    ),
  });

  return {
    name: "dict_lookup",
    label: "词典查询",
    description:
      "词典工具。op=lookup 目前为 P2 stub 返回空；op=set 把术语写入 ctx.dict；op=get 读取 ctx.dict。**source 可传（agent_search/internal/ngram/tm），缺省 agent_search**——internal 来源（从对齐数据里识别出的术语）必须显式传 source=internal，MoA 注入分段与 terms_distill 审计都按 source 走，传错会落错段。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isDictLookupParams(params) ? params : { op: "get" as const };
      const ctx: Ctx = getSessionCtx(sessionId);

      if (p.op === "lookup") {
        const result = {
          ok: true,
          op: "lookup",
          entries: [] as DictEntry[],
          _note: "P2 stub: dict_lookup 后端未接入，当前恒为空",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }

      if (p.op === "set") {
        const incoming = (p.entries ?? []).map(coerceEntry).filter((e): e is DictEntry => e !== null);
        const existing = ctx.dict ?? [];
        const map = new Map<string, DictEntry>();
        for (const e of existing) map.set(`${e.word}\u0000${e.text}`, e);
        for (const e of incoming) map.set(`${e.word}\u0000${e.text}`, e);
        const merged = [...map.values()];
        setSessionCtx(sessionId, { ...ctx, dict: merged });
        // 增量持久化：agent 收集的术语落盘。
        await persistSessionCtx(sessionId);
        const result = { ok: true, op: "set", added: incoming.length, total: merged.length };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }

      const result = { ok: true, op: "get", entries: ctx.dict ?? [] };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
