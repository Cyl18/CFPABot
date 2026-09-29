import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { gh } from "../../github/client.ts";
import { prdata } from "../../prdata.ts";
import { requirePr, type ToolContext } from "../context.ts";
import { buildPack, findingHistogram, selectRows, workspaceKey } from "../pack.ts";
import { vanillaTerms } from "../terms.ts";
import { jsonResult, pageOf } from "./shared.ts";

const REVIEW_LOAD_PARAMS = Type.Object({});
const REVIEW_ROWS_PARAMS = Type.Object({
  workspace: Type.Optional(Type.String({ description: "slug/version/namespace，省略则覆盖全部工作区" })),
  filter: Type.Optional(
    Type.Union([Type.Literal("changed"), Type.Literal("flagged"), Type.Literal("all")], {
      description: "默认 changed",
    }),
  ),
  query: Type.Optional(Type.String({ description: "在 key/原文/译文里做子串搜索" })),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number({ description: "默认 60，上限 200" })),
});

export function reviewLoadTool(ctx: ToolContext): AgentTool<typeof REVIEW_LOAD_PARAMS> {
  return {
    name: "review_load",
    label: "加载审查数据",
    description:
      "对齐 PR 变更的 base/head 语言文件，生成逐 key 审查行（含 head 行号、是否落在 diff 新侧、程序/术语/QA 提示）。结果保存在服务端，用 review_rows 分页查看。",
    parameters: REVIEW_LOAD_PARAMS,
    execute: async () => {
      const { prNumber, baseSha, headSha } = requirePr(ctx);
      const { files } = await prdata.files(prNumber);
      const pack = await buildPack({
        prNumber,
        baseSha,
        headSha,
        files,
        read: (path, ref) => gh.getFile(path, ref === "base" ? baseSha : headSha),
        terms: await vanillaTerms(),
      });
      await ctx.savePack(pack);
      return jsonResult({
        ok: true,
        headSha,
        counts: pack.counts,
        workspaces: pack.workspaces.map((workspace) => ({
          workspace: workspaceKey(workspace),
          format: workspace.format,
          enPath: workspace.enPath,
          zhPath: workspace.zhPath,
          counts: workspace.counts,
          histogram: findingHistogram(workspace),
          duplicates: workspace.duplicates,
          fileFindings: workspace.fileFindings,
        })),
        note: "line 是 head 版 zh_cn 文件里的行号；inHunk 表示该行位于 PR diff 新侧区间内，只有 inHunk 的行才能写行内评论。",
      });
    },
  };
}

export function reviewRowsTool(ctx: ToolContext): AgentTool<typeof REVIEW_ROWS_PARAMS> {
  return {
    name: "review_rows",
    label: "查看审查行",
    description: "分页查看 review_load 生成的审查行；可用 query 对全文做子串搜索。",
    parameters: REVIEW_ROWS_PARAMS,
    execute: async (_toolCallId, params) => {
      const pack = await ctx.pack();
      if (!pack) throw new Error("尚未调用 review_load，请先加载审查数据");
      const selected = selectRows(pack, {
        ...(params.workspace ? { workspace: params.workspace } : {}),
        filter: params.filter ?? "changed",
        ...(params.query ? { query: params.query } : {}),
      });
      const page = pageOf(params.offset, params.limit, 200, 60);
      return jsonResult({
        total: selected.length,
        offset: page.offset,
        limit: page.limit,
        rows: selected.slice(page.offset, page.offset + page.limit).map(({ workspace, row }) => ({
          workspace: workspaceKey(workspace),
          key: row.key,
          baseEn: row.baseEn,
          headEn: row.headEn,
          baseZh: row.baseZh,
          headZh: row.headZh,
          line: row.line,
          inHunk: row.inHunk,
          changed: row.changed,
          findings: row.findings,
        })),
      });
    },
  };
}
