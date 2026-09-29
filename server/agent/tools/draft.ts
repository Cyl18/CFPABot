import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { prdata } from "../../prdata.ts";
import { requirePr, type ToolContext } from "../context.ts";
import { validateDraft } from "../draft.ts";
import { mqmTable } from "../mqm.ts";
import { jsonResult } from "./shared.ts";

const COMMENT_PARAMS = Type.Object({
  path: Type.String({ description: "文件路径" }),
  line: Type.Number({ description: "head 版文件的行号，必须落在 diff 新侧区间内" }),
  key: Type.String({ description: "语言 key" }),
  severity: Type.Union([Type.Literal("critical"), Type.Literal("major"), Type.Literal("minor"), Type.Literal("neutral")]),
  mqm: Type.String({ description: "MQM 全形 Dim/type，例如 Accuracy/mistranslation" }),
  en: Type.Optional(Type.String({ description: "英文原文" })),
  zh: Type.Optional(Type.String({ description: "当前中文译文" })),
  body: Type.String({ description: "散文原因，不要写标题" }),
  suggestion: Type.Optional(Type.String({ description: "替换后的整行译文" })),
  covers: Type.Optional(Type.Array(Type.String(), { description: "同 pattern 的其余 key（不含本条）" })),
  suspected: Type.Optional(Type.Boolean({ description: "无外部依据的存疑项" })),
});

const DRAFT_PARAMS = Type.Object({
  verdict: Type.Union([Type.Literal("approve"), Type.Literal("changes"), Type.Literal("reject")]),
  summary: Type.String({ description: "主评论正文：结论、major 一览、预审结论" }),
  comments: Type.Array(COMMENT_PARAMS),
});

export function draftSaveTool(ctx: ToolContext): AgentTool<typeof DRAFT_PARAMS> {
  return {
    name: "draft_save",
    label: "保存审查草稿",
    description: "校验并保存审查草稿。校验失败会返回 errors 列表，请修正后重试；成功只落草稿，不发布。",
    parameters: DRAFT_PARAMS,
    execute: async (_toolCallId, params) => {
      const { prNumber, headSha } = requirePr(ctx);
      const table = await mqmTable();
      const data = await prdata.files(prNumber).catch(() => null);
      const patches = new Map<string, string | undefined>((data?.files ?? []).map((file) => [file.path, file.patch]));
      const draft = {
        prNumber,
        headSha,
        verdict: params.verdict,
        summary: params.summary,
        comments: params.comments.map((comment, index) => ({ id: `c${index + 1}`, ...comment })),
      };
      const errors = validateDraft(draft, { mqmIds: table.ids, labels: table.labels, patches });
      if (errors.length > 0) return jsonResult({ ok: false, errors, mqmPrompt: table.prompt });
      const saved = await ctx.saveDraft(draft);
      return jsonResult({
        ok: true,
        verdict: saved.verdict,
        comments: saved.comments.length,
        note: "草稿已保存，发布由人工在面板确认。",
      });
    },
  };
}
