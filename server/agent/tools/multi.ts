import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { loadConfig } from "../llm.ts";
import { mqmTable } from "../mqm.ts";
import { multiReview } from "../multi-review.ts";
import { selectRows, workspaceKey } from "../pack.ts";
import { requirePr, type ToolContext } from "../context.ts";
import { createReviewers } from "../reviewers.ts";
import { jsonResult } from "./shared.ts";

const MULTI_REVIEW_PARAMS = Type.Object({
  workspace: Type.Optional(Type.String({ description: "slug/version/namespace，省略则覆盖全部工作区" })),
  keys: Type.Optional(Type.Array(Type.String(), { description: "只审这些 key" })),
  filter: Type.Optional(
    Type.Union([Type.Literal("changed"), Type.Literal("flagged"), Type.Literal("all")], {
      description: "默认 changed",
    }),
  ),
  focus: Type.Optional(Type.String({ description: "额外的审查重点" })),
  batchSize: Type.Optional(Type.Number({ description: "每批条目数，上限 30" })),
});

export function multiReviewTool(ctx: ToolContext): AgentTool<typeof MULTI_REVIEW_PARAMS> {
  return {
    name: "multi_review",
    label: "多模型精审",
    description: "把选中的审查行交给配置好的多个评审模型并行精审，返回合并后的发现（含未覆盖条目）。",
    parameters: MULTI_REVIEW_PARAMS,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      requirePr(ctx);
      const pack = await ctx.pack();
      if (!pack) throw new Error("尚未调用 review_load，请先加载审查数据");
      const selected = selectRows(pack, {
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.keys ? { keys: params.keys } : {}),
        filter: params.filter ?? "changed",
      });
      if (selected.length === 0) {
        return jsonResult({ ok: true, items: 0, findings: [], coverage: [], unreviewed: [], note: "没有符合条件的条目" });
      }
      const config = await loadConfig();
      const reviewers = await createReviewers(config.reviewers);
      const table = await mqmTable();
      const items = selected.map(({ workspace, row }) => ({
        id: `${workspaceKey(workspace)}#${row.key}`,
        key: row.key,
        en: row.headEn ?? "",
        zh: row.headZh ?? "",
        ...(row.baseEn !== undefined ? { baseEn: row.baseEn } : {}),
        ...(row.baseZh !== undefined ? { baseZh: row.baseZh } : {}),
        ...(row.findings.length > 0
          ? { notes: row.findings.map((finding) => `${finding.source}:${finding.code}: ${finding.detail}`) }
          : {}),
      }));
      const guidance = [
        table.prompt ? `受控词表（mqm 必须是全形 Dim/type）：\n${table.prompt}` : "",
        params.focus ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = await multiReview({
        items,
        reviewers,
        guidance,
        batchSize: params.batchSize,
        signal,
        onProgress: (progress) => {
          onUpdate?.({
            content: [],
            details: { progress: `${progress.reviewer} 第 ${progress.batch}/${progress.batches} 批${progress.ok ? "完成" : "失败"}` },
          });
        },
      });
      return jsonResult({
        ok: true,
        items: items.length,
        reviewers: reviewers.map((reviewer) => reviewer.id),
        findings: result.findings,
        coverage: result.coverage,
        unreviewed: result.unreviewed,
      });
    },
  };
}
