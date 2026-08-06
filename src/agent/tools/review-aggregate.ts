// src/agent/tools/review-aggregate.ts
// Custom tool: review_aggregate — aggregate ctx.reviews (MoA model results)
// + ctx.aligned program candidates into ctx.reviewTable (中间表).
// 契约 (2026-08-01): 失败≠pass；findings=[] 仅成功时推导 pass；程序候选按
// itemId join；多模型分歧标 conflict；已有 dismissed 审计幂等保留。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";
import { aggregateReviewTable, summarizeReviewTable } from "../review-aggregate.js";
import type { MoaReviewModelResult } from "./review-moa.js";
import type { LangReviewItem } from "../../flows/_shared/language/align-review-items.js";

export function createReviewAggregateTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({});

  return {
    name: "review_aggregate",
    label: "聚合审查意见",
    description:
      "把 ctx.reviews（多模型 MoA 结果）与 ctx.aligned 的程序候选聚合为中间表 ctx.reviewTable：每条目一行（status: pass/flagged/unreviewed；conflict=模型分歧）。模型失败覆盖的条目标 unreviewed，绝不等于 pass。程序候选（缺失/占位符/格式）按 itemId 并入。结果写入 ctx.reviewTable 并落盘。",
    parameters,
    execute: async () => {
      const ctx = getSessionCtx(sessionId);
      const aligned = (ctx.aligned as unknown as { items: LangReviewItem[]; candidates: unknown[] }[]) ?? [];
      const reviews = (ctx.reviews as unknown as MoaReviewModelResult[]) ?? [];
      const { rows, ambiguousFindings } = aggregateReviewTable(reviews, aligned, ctx.reviewTable);
      setSessionCtx(sessionId, { ...ctx, reviewTable: rows });
      await persistSessionCtx(sessionId);
      const summary = { ok: true, ...summarizeReviewTable(rows, ambiguousFindings) };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: summary,
      };
    },
  };
}
