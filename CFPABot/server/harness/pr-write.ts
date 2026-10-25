import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { z } from "zod";
import type { ReviewDraft } from "@cfpa/contracts/api";
import { DRAFT_FILE, parseDraftFile } from "@cfpa/review-core/draft";
import { env } from "../env.ts";
import { assertBotWrites, gh, serverGraphql } from "../github/client.ts";
import {
  createReviewComment,
  createSubmittedReview,
  replyToReviewThread,
  reviewMeta,
  setThreadResolved,
  submitPendingReview,
} from "../github/review.ts";
import { readLocal } from "../agent/local-store.ts";
import { assertCanWrite, type WriteSession } from "../agent/policy.ts";
import { publishDraft } from "../agent/workflows/review/publish.ts";
import { prdata } from "../prdata.ts";
import { errorResult, jsonResult } from "./result.ts";
import { prepareDraft, saveDraftOf, markPublishedOf } from "./review/draft.ts";
import { parseThreadState } from "./thread-state.ts";
import type { WriteTarget } from "./write-targets.ts";
import type { PrParts } from "./uri.ts";

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

function eventOf(uri: PrParts, content: string | undefined): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" {
  const fromQuery = uri.query.get("event");
  if (fromQuery !== null) {
    if (fromQuery === "COMMENT" || fromQuery === "APPROVE" || fromQuery === "REQUEST_CHANGES") return fromQuery;
    throw new Error("event 只能是 COMMENT / APPROVE / REQUEST_CHANGES。");
  }
  if (content !== undefined && content.trim() !== "") {
    try {
      const parsed = JSON.parse(content) as { event?: unknown };
      if (parsed.event === "APPROVE" || parsed.event === "REQUEST_CHANGES") return parsed.event;
    } catch {
      // JSON 错误由草稿校验给出更完整的信息。
    }
  }
  return "COMMENT";
}

function parseSubmit(content: string | undefined): { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string } {
  if (content === undefined || content.trim().length === 0) return { event: "COMMENT", body: "" };
  return submitSchema.parse(JSON.parse(content) as unknown);
}

async function writeDraft(uri: PrParts, content: string | undefined, ctx: WriteSession): Promise<AgentToolResult<Record<string, unknown>>> {
  if (content === undefined || content.trim() === "") throw new Error("write pr://<n>/draft 需要草稿 JSON。");
  const result = await saveDraftOf(uri.number, ctx.sessionId, content);
  if (!result.ok || result.draft === undefined) {
    return errorResult({
      ok: false,
      errors: result.errors,
      next: [`按 errors 修正后重写 pr://${uri.number}/draft`],
    });
  }
  await ctx.onDraftSaved?.(result.draft);
  return jsonResult({
    ok: true,
    saved: `local://${DRAFT_FILE}`,
    comments: result.draft.comments.length,
    warnings: result.warnings,
    next: result.next,
  });
}

async function writeComment(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  if (content === undefined || content.trim() === "") throw new Error("评论需要正文。");
  const marker = markerOf(ctx.sessionId, toolCallId);
  const existing = (await gh.listComments(uri.number)).find((comment) => comment.body.includes(marker));
  if (existing) return jsonResult({ ok: true, deduped: true, id: existing.id, url: existing.htmlUrl });
  const comment = await gh.createComment(uri.number, withMarker(content ?? "", ctx.sessionId, toolCallId));
  return jsonResult({ ok: true, id: comment.id, url: comment.htmlUrl });
}

async function writeInlineComment(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  if (content === undefined || content.trim() === "") throw new Error("行内评论需要正文。");
  const seg = uri.path.split("/").filter(Boolean);
  const path = seg.slice(1, -1).join("/");
  if (!path) throw new Error("行内评论需要文件路径。");
  const line = Number(uri.query.get("line"));
  if (!Number.isInteger(line) || line <= 0) throw new Error("行内评论需要 ?line=<head 行号>。");
  const marker = markerOf(ctx.sessionId, toolCallId);
  const existing = (await gh.listReviewComments(uri.number)).find((comment) => comment.body.includes(marker));
  if (existing) return jsonResult({ ok: true, deduped: true, id: existing.id, url: existing.htmlUrl });
  const thread = await createReviewComment(serverGraphql, uri.number, {
    path,
    line,
    body: withMarker(content ?? "", ctx.sessionId, toolCallId),
  });
  if (thread === null) throw new Error("PR 无法创建评论。");
  return jsonResult({ ok: true, thread });
}

async function writeThreadState(uri: PrParts, content: string | undefined) {
  const seg = uri.path.split("/").filter(Boolean);
  const threadId = seg[1] ?? "";
  const resolved = parseThreadState(content);
  await setThreadResolved(serverGraphql, threadId, resolved);
  return jsonResult({ ok: true, threadId, resolved });
}

async function writeThreadReply(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  if (content === undefined || content.trim() === "") throw new Error("线程回复需要正文。");
  const seg = uri.path.split("/").filter(Boolean);
  const comment = await replyToReviewThread(
    serverGraphql,
    seg[1] ?? "",
    withMarker(content ?? "", ctx.sessionId, toolCallId),
    env.BOT_LOGIN,
  );
  return jsonResult({ ok: true, comment });
}

async function writeReview(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  const n = uri.number;
  let draft: ReviewDraft;
  if (content !== undefined && content.trim() !== "") {
    const { pull } = await prdata.files(n);
    const prepared = prepareDraft(content, n, pull.headSha);
    if (prepared.draft === undefined) {
      return errorResult({ ok: false, errors: prepared.errors, next: [`write pr://${n}/draft 修正后再发布`] });
    }
    draft = prepared.draft;
  } else {
    const raw = await readLocal(ctx.sessionId, DRAFT_FILE);
    const saved = raw === null ? null : parseDraftFile(raw.content);
    if (saved === null) throw new Error(`没有已保存的草稿；先 write pr://${n}/draft，或在正文里给草稿 JSON。`);
    if (saved.prNumber !== n) {
      throw new Error(`已保存的草稿属于 PR #${saved.prNumber}，不能发布到 PR #${n}；先审目标 PR。`);
    }
    draft = saved;
  }
  const marker = markerOf(ctx.sessionId, toolCallId);
  const existing = (await gh.listReviews(n)).find((review) => review.body.includes(marker));
  if (existing) return jsonResult({ ok: true, deduped: true, url: existing.htmlUrl });
  const { url } = await publishDraft(draft, { event: eventOf(uri, content), marker });
  const saved = await markPublishedOf(n, ctx.sessionId, draft, url);
  await ctx.onDraftSaved?.(saved);
  return jsonResult({ ok: true, url, comments: saved.comments.length, next: [`read pr://${n}/draft 复核已发布状态`] });
}

async function writeReviewSubmit(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  const n = uri.number;
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

async function replaceComment(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  const seg = uri.path.split("/").filter(Boolean);
  const id = Number(seg[1]);
  if (!Number.isInteger(id) || id <= 0) throw new Error("评论编号无效。");
  if (content === undefined) throw new Error("替换评论需要提供新的完整正文。");
  const comment = (await gh.listComments(uri.number)).find((entry) => entry.id === id);
  if (comment === undefined) throw new Error("评论不存在。");
  if (comment.author !== env.BOT_LOGIN) throw new Error("只能编辑机器人自己的评论。");
  await gh.updateComment(id, withMarker(content, ctx.sessionId, toolCallId));
  return jsonResult({ ok: true, url: comment.htmlUrl });
}

async function replaceReviewComment(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  const seg = uri.path.split("/").filter(Boolean);
  const id = Number(seg[1]);
  if (!Number.isInteger(id) || id <= 0) throw new Error("行内评论编号无效。");
  if (content === undefined) throw new Error("替换行内评论需要提供新的完整正文。");
  const comment = (await gh.listReviewComments(uri.number)).find((entry) => entry.id === id);
  if (comment === undefined) throw new Error("行内评论不存在。");
  if (comment.author !== env.BOT_LOGIN) throw new Error("只能编辑机器人自己的行内评论。");
  await gh.updateReviewComment(id, withMarker(content, ctx.sessionId, toolCallId));
  return jsonResult({ ok: true, url: comment.htmlUrl });
}

export type WriteResult = AgentToolResult<Record<string, unknown>>;

export async function writePr(
  uri: PrParts,
  target: WriteTarget,
  content: string | undefined,
  ctx: WriteSession,
  toolCallId: string,
): Promise<WriteResult> {
  if (target.id !== "pr-draft") {
    assertCanWrite(ctx);
    assertBotWrites();
  }
  switch (target.id) {
    case "pr-draft":
      return writeDraft(uri, content, ctx);
    case "pr-comment":
      return writeComment(uri, content, ctx, toolCallId);
    case "pr-inline-comment":
      return writeInlineComment(uri, content, ctx, toolCallId);
    case "pr-thread-state":
      return writeThreadState(uri, content);
    case "pr-thread-reply":
      return writeThreadReply(uri, content, ctx, toolCallId);
    case "pr-review":
      return writeReview(uri, content, ctx, toolCallId);
    case "pr-review-submit":
      return writeReviewSubmit(uri, content, ctx, toolCallId);
    case "pr-comment-replace":
      return replaceComment(uri, content, ctx, toolCallId);
    case "pr-review-comment-replace":
      return replaceReviewComment(uri, content, ctx, toolCallId);
    default:
      throw new Error(`write 不支持的资源：${target.uri}`);
  }
}
