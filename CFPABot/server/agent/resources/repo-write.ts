import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { ReviewDraft } from "../../../shared/api.ts";
import { env } from "../../env.ts";
import { gh, serverGraphql } from "../../github/client.ts";
import {
  createReviewComment,
  createSubmittedReview,
  replyToReviewThread,
  reviewMeta,
  setThreadResolved,
  submitPendingReview,
} from "../../github/review.ts";
import type { ToolContext } from "../context.ts";
import { DRAFT_FILE, draftInputSchema, normalizeDraftJson, parseDraftFile } from "../draft.ts";
import { assertCanWrite } from "../policy.ts";
import { publishDraft } from "../publish.ts";
import { jsonResult } from "../result.ts";
import { replaceOnce } from "./replace.ts";
import { parseThreadState } from "./thread-state.ts";
import { uriSegments, type RepoUri } from "./uri.ts";

const AGENT_MARKER_PREFIX = "<!--CFPA-AGENT:";
const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;

const submitSchema = z.object({
  event: z.enum(REVIEW_EVENTS),
  body: z.string(),
});

function markerOf(sessionId: string, toolCallId: string): string {
  return `${AGENT_MARKER_PREFIX}${sessionId}:${toolCallId}-->`;
}

function withMarker(body: string, sessionId: string, toolCallId: string): string {
  return body.includes(AGENT_MARKER_PREFIX) ? body : `${body}\n\n${markerOf(sessionId, toolCallId)}`;
}

async function parseDraft(content: string, n: number, ctx: ToolContext): Promise<{
  draft: ReviewDraft;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
}> {
  const input = draftInputSchema.parse(normalizeDraftJson(JSON.parse(content) as unknown));
  if (input.prNumber !== n) throw new Error("草稿的 PR 与会话不一致。");
  const headSha = input.headSha ?? (ctx.prNumber === n ? ctx.headSha : null) ?? (await gh.getPull(n)).headSha;
  return {
    draft: {
      prNumber: input.prNumber,
      headSha,
      verdict: input.verdict,
      summary: input.summary,
      comments: input.comments,
      updatedAt: new Date().toISOString(),
    },
    event: input.event ?? "COMMENT",
  };
}

function parseSubmit(content: string | undefined): { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string } {
  if (content === undefined || content.trim().length === 0) return { event: "COMMENT", body: "" };
  return submitSchema.parse(JSON.parse(content) as unknown);
}

function prNumberOf(seg: string[], action: "write" | "edit"): number {
  if (seg[0] !== "pr") throw new Error(`${action} 只支持 repo://pr/<n>/... 资源。`);
  const n = Number(seg[1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${action} 只支持 repo://pr/<n>/... 资源。`);
  return n;
}

export async function writeRepo(
  uri: RepoUri,
  content: string | undefined,
  ctx: ToolContext,
  toolCallId: string,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const seg = uriSegments(uri);
  const n = prNumberOf(seg, "write");
  assertCanWrite(ctx);

  if (seg.length === 3 && seg[2] === "comments") {
    const marker = markerOf(ctx.sessionId, toolCallId);
    const existing = (await gh.listComments(n)).find((comment) => comment.body.includes(marker));
    if (existing) return jsonResult({ ok: true, deduped: true, id: existing.id, url: existing.htmlUrl });
    const comment = await gh.createComment(n, withMarker(content ?? "", ctx.sessionId, toolCallId));
    return jsonResult({ ok: true, id: comment.id, url: comment.htmlUrl });
  }

  if (seg[2] === "files" && seg.at(-1) === "comments") {
    const path = seg.slice(3, -1).join("/");
    if (!path) throw new Error("行内评论需要文件路径。");
    const line = Number(uri.query.get("line"));
    if (!Number.isInteger(line) || line <= 0) throw new Error("行内评论需要 ?line=<head 行号>。");
    const marker = markerOf(ctx.sessionId, toolCallId);
    const existing = (await gh.listReviewComments(n)).find((comment) => comment.body.includes(marker));
    if (existing) return jsonResult({ ok: true, deduped: true, id: existing.id, url: existing.htmlUrl });
    const thread = await createReviewComment(serverGraphql, n, {
      path,
      line,
      body: withMarker(content ?? "", ctx.sessionId, toolCallId),
    });
    if (thread === null) throw new Error("PR 无法创建评论。");
    return jsonResult({ ok: true, thread });
  }

  if (seg.length === 4 && seg[2] === "threads") {
    const threadId = seg[3] ?? "";
    const resolved = parseThreadState(content);
    await setThreadResolved(serverGraphql, threadId, resolved);
    return jsonResult({ ok: true, threadId, resolved });
  }

  if (seg.length === 5 && seg[2] === "threads" && seg[4] === "replies") {
    const comment = await replyToReviewThread(
      serverGraphql,
      seg[3] ?? "",
      withMarker(content ?? "", ctx.sessionId, toolCallId),
      env.BOT_LOGIN,
    );
    return jsonResult({ ok: true, comment });
  }

  if (seg.length === 3 && seg[2] === "review") {
    const marker = markerOf(ctx.sessionId, toolCallId);
    const existing = (await gh.listReviews(n)).find((review) => review.body.includes(marker));
    if (existing) return jsonResult({ ok: true, deduped: true, url: existing.htmlUrl });
    const parsed =
      content !== undefined && content.trim().length > 0
        ? await parseDraft(content, n, ctx)
        : { draft: parseDraftFile((await ctx.local(DRAFT_FILE))?.content), event: "COMMENT" as const };
    if (parsed.draft === null) throw new Error("没有可发布的审查草稿。");
    if (parsed.draft.prNumber !== n) throw new Error("草稿的 PR 与会话不一致。");
    const { url } = await publishDraft(parsed.draft, {
      event: parsed.event,
      marker: markerOf(ctx.sessionId, toolCallId),
    });
    return jsonResult({ ok: true, url });
  }

  if (seg.length === 4 && seg[2] === "review" && seg[3] === "submit") {
    const input = parseSubmit(content);
    const marker = markerOf(ctx.sessionId, toolCallId);
    const existing = (await gh.listReviews(n)).find((review) => review.body.includes(marker));
    if (existing) return jsonResult({ ok: true, deduped: true, url: existing.htmlUrl });
    const body = withMarker(input.body, ctx.sessionId, toolCallId);
    const meta = await reviewMeta(serverGraphql, n);
    if (meta === null) throw new Error("PR 不存在。");
    let url: string;
    if (meta.pendingReviewId !== null) {
      url = await submitPendingReview(serverGraphql, meta.pendingReviewId, input.event, body);
    } else {
      if (input.event === "COMMENT" && input.body.trim().length === 0) {
        throw new Error("没有待提交的评论，也没有填写总结。");
      }
      url = await createSubmittedReview(serverGraphql, meta.pullRequestId, meta.headSha, input.event, body);
    }
    return jsonResult({ ok: true, url });
  }

  throw new Error(
    `write 不支持的资源：repo://${uri.path}。可写：comments、files/<path>/comments、threads/<id>、threads/<id>/replies、review、review/submit。`,
  );
}

export async function editRepo(
  uri: RepoUri,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  ctx: ToolContext,
  toolCallId: string,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const seg = uriSegments(uri);
  const n = prNumberOf(seg, "edit");
  assertCanWrite(ctx);

  if (seg.length === 4 && seg[2] === "comments") {
    const id = Number(seg[3]);
    if (!Number.isInteger(id) || id <= 0) throw new Error("评论编号无效。");
    const comment = (await gh.listComments(n)).find((entry) => entry.id === id);
    if (comment === undefined) throw new Error("评论不存在。");
    if (comment.author !== env.BOT_LOGIN) throw new Error("只能编辑机器人自己的评论。");
    const next = withMarker(replaceOnce(comment.body, oldString, newString, replaceAll), ctx.sessionId, toolCallId);
    await gh.updateComment(id, next);
    return jsonResult({ ok: true, url: comment.htmlUrl });
  }

  if (seg.length === 4 && seg[2] === "review-comments") {
    const id = Number(seg[3]);
    if (!Number.isInteger(id) || id <= 0) throw new Error("行内评论编号无效。");
    const comment = (await gh.listReviewComments(n)).find((entry) => entry.id === id);
    if (comment === undefined) throw new Error("行内评论不存在。");
    if (comment.author !== env.BOT_LOGIN) throw new Error("只能编辑机器人自己的评论。");
    const next = withMarker(replaceOnce(comment.body, oldString, newString, replaceAll), ctx.sessionId, toolCallId);
    await gh.updateReviewComment(id, next);
    return jsonResult({ ok: true, url: comment.htmlUrl });
  }

  throw new Error("edit 只支持评论正文：repo://pr/<n>/comments/<id> 或 /review-comments/<id>。");
}
