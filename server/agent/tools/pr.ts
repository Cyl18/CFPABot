import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getCheckReport } from "../../bot/index.ts";
import { parseLangPath, workspacesOf } from "../../domain/path.ts";
import { env } from "../../env.ts";
import { gh } from "../../github/client.ts";
import { prdata } from "../../prdata.ts";
import { requirePr, type ToolContext } from "../context.ts";
import { jsonResult, pageOf, safePath } from "./shared.ts";

const PR_OVERVIEW_PARAMS = Type.Object({});
const PR_DISCUSSION_PARAMS = Type.Object({});
const PR_READ_PARAMS = Type.Object({
  path: Type.String({ description: "文件路径" }),
  ref: Type.Union([Type.Literal("base"), Type.Literal("head")], { description: "base 为 PR 基线，head 为 PR 最新提交" }),
  offset: Type.Optional(Type.Number({ description: "起始行号，1 基，默认 1" })),
  limit: Type.Optional(Type.Number({ description: "读取行数，默认 200，上限 2000" })),
});

const BODY_LIMIT = 2000;
const MAX_FILES = 200;

function isBotAuthor(author: string): boolean {
  return author === env.BOT_LOGIN || author === "Cyl18-Bot" || author.endsWith("[bot]");
}

function trimBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > BODY_LIMIT ? `${trimmed.slice(0, BODY_LIMIT)}…[已截断]` : trimmed;
}

export function prOverviewTool(ctx: ToolContext): AgentTool<typeof PR_OVERVIEW_PARAMS> {
  return {
    name: "pr_overview",
    label: "PR 概览",
    description: "读取绑定 PR 的元数据、变更文件、语言工作区、特殊文件、相关 PR 与检查结果。",
    parameters: PR_OVERVIEW_PARAMS,
    execute: async () => {
      const { prNumber, baseSha, headSha } = requirePr(ctx);
      const { pull, files } = await prdata.files(prNumber);
      const workspaces = workspacesOf(files);
      const checks = await getCheckReport(prNumber);
      return jsonResult({
        prNumber,
        title: pull.title,
        author: pull.author,
        state: pull.merged ? "merged" : pull.state,
        draft: pull.draft,
        labels: pull.labels,
        baseSha,
        headSha,
        baseRef: pull.baseRef,
        headRef: pull.headRef,
        htmlUrl: pull.htmlUrl,
        fileCount: files.length,
        filesTruncated: files.length > MAX_FILES,
        files: files.slice(0, MAX_FILES).map((file) => ({
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          previousPath: file.previousPath,
        })),
        workspaces: workspaces.map((workspace) => ({
          slug: workspace.slug,
          version: workspace.version,
          namespace: workspace.namespace,
          files: workspace.files,
        })),
        specialFiles: files
          .filter((file) => parseLangPath(file.path) === null)
          .slice(0, 100)
          .map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions })),
        related: prdata.related(prNumber),
        checks: checks?.items ?? [],
      });
    },
  };
}

export function prDiscussionTool(ctx: ToolContext): AgentTool<typeof PR_DISCUSSION_PARAMS> {
  return {
    name: "pr_discussion",
    label: "PR 讨论",
    description: "读取绑定 PR 的 issue 评论与行内 review 评论（已排除机器人），用于了解作者意图与既有讨论。",
    parameters: PR_DISCUSSION_PARAMS,
    execute: async () => {
      const { prNumber } = requirePr(ctx);
      const [comments, reviews] = await Promise.all([gh.listComments(prNumber), gh.listReviewComments(prNumber)]);
      return jsonResult({
        issueComments: comments
          .filter((comment) => !comment.isBot && !isBotAuthor(comment.author))
          .map((comment) => ({ author: comment.author, body: trimBody(comment.body), at: comment.createdAt })),
        reviewComments: reviews
          .filter((comment) => !isBotAuthor(comment.author))
          .map((comment) => ({
            author: comment.author,
            path: comment.path,
            line: comment.line,
            body: trimBody(comment.body),
            at: comment.createdAt,
          })),
        note: "已排除机器人评论",
      });
    },
  };
}

export function prReadTool(ctx: ToolContext): AgentTool<typeof PR_READ_PARAMS> {
  return {
    name: "pr_read",
    label: "读取 PR 文件",
    description: "按行读取 PR 中某个文件的 base 或 head 版本内容，用于查看手册、配置等非语言文件。",
    parameters: PR_READ_PARAMS,
    execute: async (_toolCallId, params) => {
      const { baseSha, headSha } = requirePr(ctx);
      const path = safePath(params.path);
      const content = await gh.getFile(path, params.ref === "base" ? baseSha : headSha);
      if (content === null) throw new Error(`文件不存在: ${path} @ ${params.ref}`);
      const lines = content.split(/\r?\n/);
      const page = pageOf(params.offset === undefined ? undefined : params.offset - 1, params.limit, 2000, 200);
      const slice = lines.slice(page.offset, page.offset + page.limit);
      return jsonResult({
        path,
        ref: params.ref,
        totalLines: lines.length,
        from: page.offset + 1,
        lines: slice.map((text, index) => `${page.offset + index + 1}\t${text}`),
      });
    },
  };
}
