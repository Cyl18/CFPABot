// src/agent/tools/review-finalize.ts
// Custom tool: review_finalize — 把 agent 整理后的最终意见写入 ctx.finalTable
// （只含有意见的条目），并把被驳回的意见记入 ctx.reviewTable 审计（仅保留在
// 中间表，不进最终表）。
// 契约 (2026-08-01): finalRows 的 itemId 必须存在于 reviewTable；dismissed 的
// itemId 必须存在且当时是 flagged；驳回理由必填。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx, type FinalRow, type ReviewAggRow } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";

const SEVERITIES = ["info", "warning", "error"] as const;

interface FinalRowInput {
  itemId: string;
  key: string;
  path: string;
  version?: string;
  domain?: string;
  en?: string;
  zh?: string;
  severity: "info" | "warning" | "error";
  review: string;
  suggestion?: string;
}

interface DismissedInput {
  itemId: string;
  reason: string;
}

interface ReviewFinalizeParams {
  finalRows: FinalRowInput[];
  dismissed: DismissedInput[];
}

function isReviewFinalizeParams(x: unknown): x is ReviewFinalizeParams {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return Array.isArray(p.finalRows) && Array.isArray(p.dismissed ?? []);
}

/**
 * 校验最终意见/驳回输入(纯函数, 供 execute 与测试复用)。
 * 契约 (2026-08-01) + 互斥: finalRows 的 itemId 必须存在于 reviewTable; dismissed 的
 * itemId 必须存在且当时是 flagged; 驳回理由必填; 同一 itemId 不得同时出现在
 * finalRows 与 dismissed(被驳回的意见不进最终表, 反之亦然)。
 */
export function validateReviewFinalize(
  params: ReviewFinalizeParams,
  table: ReviewAggRow[],
): { errors: string[]; finalRows: FinalRow[] } {
  // unknownItem 行是模型脏 itemId 的兜底行，不可被 finalize/dismissed 引用。
  const tableIds = new Set(table.filter((r) => !r.unknownItem).map((r) => r.itemId));
  const dismissedIds = new Set((params.dismissed ?? []).map((d) => d.itemId));
  const errors: string[] = [];
  const finalRows: FinalRow[] = [];

  for (const f of params.finalRows) {
    if (!tableIds.has(f.itemId)) {
      errors.push(`finalRows 的 itemId 不存在于 reviewTable: ${f.itemId}`);
      continue;
    }
    if (dismissedIds.has(f.itemId)) {
      errors.push(`finalRows 与 dismissed 同时包含 itemId: ${f.itemId}(已驳回的意见不能进最终表)`);
      continue;
    }
    if (!f.review.trim()) {
      errors.push(`finalRows ${f.itemId} 的 review 为空`);
      continue;
    }
    if (!SEVERITIES.includes(f.severity)) {
      errors.push(`finalRows ${f.itemId} 的 severity 非法: ${f.severity}`);
      continue;
    }
    finalRows.push({ ...f, severity: f.severity });
  }
  for (const d of params.dismissed ?? []) {
    if (!tableIds.has(d.itemId)) {
      errors.push(`dismissed 的 itemId 不存在于 reviewTable: ${d.itemId}`);
      continue;
    }
    const row = table.find((r) => r.itemId === d.itemId);
    if (row && row.status !== "flagged") {
      errors.push(`dismissed 的 itemId 不是 flagged（没有意见可驳回）: ${d.itemId}`);
      continue;
    }
    if (!d.reason.trim()) {
      errors.push(`dismissed ${d.itemId} 缺少驳回理由`);
    }
  }
  return { errors, finalRows };
}

export function createReviewFinalizeTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    finalRows: Type.Array(
      Type.Object({
        itemId: Type.String({ description: "必须存在于 ctx.reviewTable 的条目 id" }),
        key: Type.String({ description: "条目 key" }),
        path: Type.String({ description: "文件路径（手册表用 zh path）" }),
        version: Type.Optional(Type.String()),
        domain: Type.Optional(Type.String()),
        en: Type.Optional(Type.String()),
        zh: Type.Optional(Type.String()),
        severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
        review: Type.String({ description: "最终审查意见（非空）" }),
        suggestion: Type.Optional(Type.String()),
      }),
      { description: "最终意见行（只含有意见的）" },
    ),
    dismissed: Type.Array(
      Type.Object({
        itemId: Type.String({ description: "被驳回意见的条目 id（必须存在于 reviewTable）" }),
        reason: Type.String({ description: "驳回理由（审计必填）" }),
      }),
      { description: "被驳回的审查意见 —— 仅记入中间表审计，不进 finalTable" },
    ),
  });

  return {
    name: "review_finalize",
    label: "生成最终意见表",
    description:
      "把整理后的最终审查意见写入 ctx.finalTable：key/en/zh/严重程度/意见/建议，只含有意见的条目。finalRows 的 itemId 必须存在于 ctx.reviewTable（先 review_aggregate）；dismissed 列出被你驳回的意见（只记审计、不进最终表）。写入后落盘。",
    parameters,
    execute: async (_toolCallId, params) => {
      if (!isReviewFinalizeParams(params)) {
        const err = { ok: false, errors: ["无效参数：需要 finalRows[] 与 dismissed[]"] };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }
      const ctx = getSessionCtx(sessionId);
      const table = ctx.reviewTable ?? [];

      // ── Validate (纯函数: 存在性/severity/review 非空/驳回前置/互斥) ──
      const { errors, finalRows } = validateReviewFinalize(params, table);
      if (errors.length > 0) {
        // 失败时附 reviewTable 的合法 itemId 快照, agent 可直接按快照修正
        // payload, 不必再调 ctx_get 翻找合法 id(省 token 也避免二次失败)。
        // unknownItem 兜底行不可引用, 快照排除。
        const err = {
          ok: false,
          errors,
          validItemIds: table.filter((r) => !r.unknownItem).map((r) => ({ itemId: r.itemId, status: r.status })),
        };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }

      // ── Write finalTable + dismissed audit ────────────────────
      const at = new Date().toISOString();
      const dismissedById = new Map(params.dismissed.map((d) => [d.itemId, d.reason]));
      const nextTable = table.map((r) =>
        dismissedById.has(r.itemId)
          ? { ...r, dismissed: { by: "agent" as const, reason: dismissedById.get(r.itemId)!, at } }
          : r,
      );

      setSessionCtx(sessionId, {
        ...ctx,
        finalTable: finalRows,
        reviewTable: nextTable,
      });
      await persistSessionCtx(sessionId);

      const summary = {
        ok: true,
        finalCount: finalRows.length,
        dismissedCount: params.dismissed.length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: summary,
      };
    },
  };
}
