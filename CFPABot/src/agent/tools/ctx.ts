// src/agent/tools/ctx.ts
// Session-ctx get/set tools — expose ctx read/write to the agent.
// Data lives in process memory (src/agent/session-ctx.ts), not disk.
// The agent uses these to carry large blobs (diffs, findings, draft…)
// across turns so they never get pasted into transcript.

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getSessionCtx,
  mergeSessionCtx,
} from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";

export interface CtxGetParams {
  key?: string;
  /** 仅数组数据: 按行级 status 过滤（reviewTable 的 pass/flagged/unreviewed）。 */
  status?: "pass" | "flagged" | "unreviewed";
  /** 仅数组数据: 只取这些 itemId。 */
  ids?: string[];
  /** 仅数组数据: 按 mod.gameVersion 子串过滤（渐进披露裁决按版本分批）。 */
  version?: string;
  /** 仅数组数据: 过滤后切片起点。 */
  offset?: number;
  /** 仅数组数据: 过滤后最多返回条数。超过时 truncated=true, 可翻页。 */
  limit?: number;
}

export interface CtxSetParams {
  key: string;
  value: unknown;
}

function isCtxGetParams(x: unknown): x is CtxGetParams {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    (p.key === undefined || typeof p.key === "string") &&
    (p.status === undefined ||
      p.status === "pass" ||
      p.status === "flagged" ||
      p.status === "unreviewed") &&
    (p.ids === undefined ||
      (Array.isArray(p.ids) && p.ids.every((v) => typeof v === "string"))) &&
    (p.version === undefined || typeof p.version === "string") &&
    (p.offset === undefined || (typeof p.offset === "number" && p.offset >= 0)) &&
    (p.limit === undefined || (typeof p.limit === "number" && p.limit >= 1))
  );
}

function isCtxSetParams(x: unknown): x is CtxSetParams {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return typeof p.key === "string";
}

// reviewTable 行体积大头是 findings 嵌套数组, 裁决前先扫 topIssue 快速定位。
const REVIEW_FINDING_RANK: Record<string, number> = { error: 3, warning: 2, info: 1 };

function projectTopIssue(row: unknown): unknown {
  if (row === null || typeof row !== "object") return row;
  const r = row as Record<string, unknown>;
  if (!Array.isArray(r.findings) || r.findings.length === 0) return row;
  let top: Record<string, unknown> | null = null;
  let topRank = -1;
  for (const f of r.findings) {
    if (f === null || typeof f !== "object") continue;
    const fr = f as Record<string, unknown>;
    const rank =
      typeof fr.severity === "string" ? (REVIEW_FINDING_RANK[fr.severity] ?? 0) : 0;
    if (rank > topRank) {
      topRank = rank;
      top = fr;
    }
  }
  if (!top) return row;
  const severity = typeof top.severity === "string" ? top.severity : "?";
  const issueType = typeof top.issueType === "string" ? top.issueType : "";
  const detail = typeof top.detail === "string" ? top.detail : "";
  return { ...r, topIssue: `${severity}${issueType ? "·" + issueType : ""}: ${detail.slice(0, 120)}` };
}

// 大数组 key 默认分页, 避免 Agent 一次全拉被截断。
const PAGED_KEYS: Record<string, true> = {
  reviewTable: true,
  reviews: true,
  finalTable: true,
  aligned: true,
};

export function createCtxGetTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    key: Type.Optional(
      Type.String({ description: "要读取的 ctx 顶层 key（省略则返回全量 ctx）" }),
    ),
    status: Type.Optional(
      Type.Union([
        Type.Literal("pass"),
        Type.Literal("flagged"),
        Type.Literal("unreviewed"),
      ], {
        description: "仅数组数据：按行级 status 过滤（如 reviewTable 只取 flagged/unreviewed）",
      }),
    ),
    ids: Type.Optional(
      Type.Array(Type.String(), { description: "仅数组数据：只取这些 itemId" }),
    ),
    version: Type.Optional(
      Type.String({ description: "仅数组数据：按 mod.gameVersion 子串过滤（按版本分批裁决）" }),
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "仅数组数据：过滤后切片起点" }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, description: "仅数组数据：最多返回条数，超过则 truncated=true 可翻页" }),
    ),
  });

  return {
    name: "ctx_get",
    label: "读 Session Ctx",
    description:
      "读取当前 session 的上下文对象。省略 key 时返回全量 ctx；传入 key 时仅返回 ctx[key]。" +
      "大数组 reviewTable/reviews/finalTable/aligned 默认只返回前 50 条（返回 truncated=true 时用 offset 翻页），" +
      "可用 status/ids/version 过滤缩小范围；reviewTable 行附加 topIssue 紧凑字段（最高严重度意见的一句话），" +
      "先扫 topIssue 定位再精读。用于跨轮次获取之前写入的大数据（diff、findings、draft…）。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isCtxGetParams(params) ? params : {};
      const ctx = getSessionCtx(sessionId);
      const raw = p.key ? ctx[p.key] : ctx;
      let data = raw;
      let total = 0;
      let filtered = 0;
      let truncated = false;

      if (Array.isArray(raw) && (p.status || p.ids || p.version || p.offset !== undefined || p.limit !== undefined)) {
        total = raw.length;
        let list: unknown[] = raw;
        if (p.status) {
          list = list.filter(
            (row) =>
              row !== null && typeof row === "object" &&
              (row as Record<string, unknown>).status === p.status,
          );
        }
        if (p.ids && p.ids.length > 0) {
          const idSet = new Set(p.ids);
          list = list.filter(
            (row) =>
              row !== null && typeof row === "object" &&
              typeof (row as Record<string, unknown>).itemId === "string" &&
              idSet.has((row as Record<string, unknown>).itemId as string),
          );
        }
        if (p.version) {
          const v = p.version;
          list = list.filter((row) => {
            if (row === null || typeof row !== "object") return false;
            const r = row as Record<string, unknown>;
            // 合并条目: versions 数组匹配任一版本; 旧形状回退 mod.gameVersion。
            if (Array.isArray(r.versions) && r.versions.length > 0) {
              return r.versions.some((vr) => {
                if (vr === null || typeof vr !== "object") return false;
                const gv = (vr as Record<string, unknown>).gameVersion;
                return typeof gv === "string" && gv.includes(v);
              });
            }
            const mod = r.mod;
            if (mod === null || typeof mod !== "object") return false;
            const gv = (mod as Record<string, unknown>).gameVersion;
            return typeof gv === "string" && gv.includes(v);
          });
        }
        filtered = list.length;
        const effectiveLimit = p.limit ?? (p.key !== undefined && PAGED_KEYS[p.key] ? 50 : undefined);
        const start = p.offset ?? 0;
        const sliced =
          effectiveLimit !== undefined
            ? list.slice(start, start + effectiveLimit)
            : list.slice(start);
        truncated = effectiveLimit !== undefined && start + sliced.length < filtered;
        data = sliced.map(projectTopIssue);
      } else if (Array.isArray(raw) && p.key !== undefined && PAGED_KEYS[p.key]) {
        // 大数组 key 未传任何过滤也默认分页。
        total = raw.length;
        filtered = raw.length;
        const sliced = raw.slice(0, 50);
        truncated = sliced.length < raw.length;
        data = sliced.map(projectTopIssue);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              key: p.key ?? null,
              ...(total > 0 ? { total, filtered, offset: p.offset ?? 0, truncated } : {}),
              data,
            }),
          },
        ],
        details: { ok: true, key: p.key ?? null, ...(total > 0 ? { total, filtered, truncated } : {}), data },
      };
    },
  };
}

export function createCtxSetTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    key: Type.String({ description: "要写入的 ctx 顶层 key（如 dict / reviews / draft）" }),
    value: Type.Any({ description: "要合并写入的值（JSON）" }),
  });

  return {
    name: "ctx_set",
    label: "写 Session Ctx",
    description:
      "向当前 session 上下文写入一个顶层 key。已存在对象时执行浅合并（{...old, ...value})，数组 / 基础类型直接替换。大数据请走此工具，不要粘贴到消息里。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isCtxSetParams(params) ? params : { key: "misc", value: params };
      const ctx = getSessionCtx(sessionId);
      const existing = ctx[p.key];
      // shallow merge for plain objects, replace otherwise
      const merged =
        existing && typeof existing === "object" && !Array.isArray(existing) &&
        p.value && typeof p.value === "object" && !Array.isArray(p.value)
          ? { ...existing, ...(p.value as Record<string, unknown>) }
          : p.value;
      mergeSessionCtx(sessionId, { [p.key]: merged });
      // 增量持久化：ctx_set 是 agent 任意写入点（finalTable/报告等），写后即落盘。
      await persistSessionCtx(sessionId);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, key: p.key }) }],
        details: { ok: true, key: p.key },
      };
    },
  };
}
