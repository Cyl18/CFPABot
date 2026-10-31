import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { z } from "zod";
import type { ReviewDraft, ReviewEvent, ReviewThread, Verdict } from "@cfpa/contracts/api";
import { DRAFT_FILE } from "@cfpa/review-core/draft";
import { inHunks, patchHunks } from "@cfpa/review-core/domain/diff";
import { parseTermInput, termCounts, validateTermTable } from "@cfpa/review-core/domain/term-table";
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
import { prepareDraft, saveDraftOf, markPublishedOf, storedDraftOf, unreviewedSlices, withServerFilledFields, lineOfKey } from "./review/draft.ts";
import { writeWorkPack } from "./review/workpack.ts";
import { saveTermTable } from "./review/term-store.ts";
import { loadPack } from "./pack.ts";
import { parseThreadState } from "./thread-state.ts";
import { invalidateThreads, threadsOf } from "./review/threads.ts";
import { specialContents, specialPairs } from "../views/special.ts";
import type { WriteTarget } from "./write-targets.ts";
import type { PrParts } from "./uri.ts";

const AGENT_MARKER_PREFIX = "<!--CFPA-AGENT:";
const AGENT_MARKER_RE = /<!--CFPA-AGENT:[\s\S]*?-->/g;
const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;

const submitSchema = z.object({
  event: z.enum(REVIEW_EVENTS),
  body: z.string(),
});
type SubmitInput = z.infer<typeof submitSchema>;

function markerOf(sessionId: string, toolCallId: string): string {
  return `${AGENT_MARKER_PREFIX}${sessionId}:${toolCallId}-->`;
}

function withMarker(body: string, sessionId: string, toolCallId: string): string {
  return `${body.replace(AGENT_MARKER_RE, "").trimEnd()}\n\n${markerOf(sessionId, toolCallId)}`;
}

/** 结论即动作：approve 批、changes 要求改、reject 只留评论。显式 event 仍可覆盖。 */
const EVENT_OF_VERDICT: Record<Verdict, ReviewEvent> = {
  approve: "APPROVE",
  changes: "REQUEST_CHANGES",
  reject: "COMMENT",
};

function eventOf(uri: PrParts, draft: Pick<ReviewDraft, "verdict" | "event">): ReviewEvent {
  const value = uri.query.get("event") ?? draft.event ?? EVENT_OF_VERDICT[draft.verdict] ?? "COMMENT";
  if (value === "COMMENT" || value === "APPROVE" || value === "REQUEST_CHANGES") return value;
  throw new Error("event 只能是 COMMENT / APPROVE / REQUEST_CHANGES。");
}

function parseSubmit(content: string | undefined): { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string } {
  if (content === undefined || content.trim().length === 0) return { event: "COMMENT", body: "" };
  return submitSchema.parse(JSON.parse(content) as unknown);
}

async function writeDraft(uri: PrParts, content: string | undefined, ctx: WriteSession): Promise<AgentToolResult<Record<string, unknown>>> {
  // 空正文 = 复用 local://draft.json：可以先 edit 几行，再整份校验落盘。
  let body = content ?? "";
  let reused = false;
  if (body.trim() === "") {
    const raw = await readLocal(ctx.sessionId, DRAFT_FILE);
    if (raw === null) throw new Error("没有已保存的草稿；正文里给草稿 JSON，或先写 local://draft.json。");
    body = raw.content;
    reused = true;
  }
  const result = await saveDraftOf(uri.number, ctx.sessionId, body);
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
    ...(reused ? { reused: `local://${DRAFT_FILE}` } : {}),
    // 回显服务端拼好的整行；不用先保存再读回来验证。
    comments: result.draft.comments.map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      key: comment.key,
      severity: comment.severity,
      ...(comment.suggestion === undefined ? {} : { suggestion: comment.suggestion }),
    })),
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
  const marker = markerOf(ctx.sessionId, toolCallId);
  const existing = (await gh.listReviewComments(uri.number)).find((comment) => comment.body.includes(marker));
  if (existing) return jsonResult({ ok: true, deduped: true, id: existing.id, url: existing.htmlUrl });
  const key = uri.query.get("key")?.trim() ?? "";
  const line = key === "" ? Number(uri.query.get("line")) : await lineOfKey(uri.number, path, key);
  if (line === null) throw new Error(`pack 里找不到 ${path} 的 key：${key}；改用 ?line=<head 行号>。`);
  if (!Number.isInteger(line) || line <= 0) {
    throw new Error("行内评论需要 ?line=<head 行号> 或 ?key=<key>。");
  }
  const { files } = await prdata.files(uri.number);
  const patch = files.find((file) => file.path === path)?.patch;
  if (patch !== undefined && patch !== "" && !inHunks(line, patchHunks(patch))) {
    throw new Error(`line ${line} 不在 ${path} 的 diff hunk 新侧；换 key 或确认 head 行号。`);
  }
  const thread = await createReviewComment(serverGraphql, uri.number, {
    path,
    line,
    body: withMarker(content ?? "", ctx.sessionId, toolCallId),
  });
  if (thread === null) throw new Error("PR 无法创建评论。");
  invalidateThreads(uri.number);
  return jsonResult({
    ok: true,
    thread,
    next: [`write pr://${uri.number}/review/submit 提交待审评论`],
  });
}

async function ownedThread(n: number, threadId: string): Promise<ReviewThread> {
  const view = await threadsOf(n, undefined, true);
  if (!view.available) throw new Error(`读取 review 线程失败：${view.error ?? "未知错误"}`);
  const thread = view.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) throw new Error(`线程 ${threadId} 不属于 PR #${n}；拒绝写入。`);
  return thread;
}

async function writeThreadState(uri: PrParts, content: string | undefined) {
  const seg = uri.path.split("/").filter(Boolean);
  const threadId = seg[1] ?? "";
  const resolved = parseThreadState(content);
  await ownedThread(uri.number, threadId);
  await setThreadResolved(serverGraphql, threadId, resolved);
  invalidateThreads(uri.number);
  return jsonResult({ ok: true, threadId, resolved });
}

async function writeThreadReply(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  if (content === undefined || content.trim() === "") throw new Error("线程回复需要正文。");
  const seg = uri.path.split("/").filter(Boolean);
  const threadId = seg[1] ?? "";
  const thread = await ownedThread(uri.number, threadId);
  const marker = markerOf(ctx.sessionId, toolCallId);
  const existing = thread.comments.find((comment) => comment.body.includes(marker));
  if (existing !== undefined) return jsonResult({ ok: true, deduped: true, comment: existing });
  const comment = await replyToReviewThread(
    serverGraphql,
    threadId,
    withMarker(content, ctx.sessionId, toolCallId),
    env.BOT_LOGIN,
  );
  invalidateThreads(uri.number);
  return jsonResult({ ok: true, comment });
}

async function writeReview(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  const n = uri.number;
  let draft: ReviewDraft;
  if (content !== undefined && content.trim() !== "") {
    const { pull } = await prdata.files(n);
    const prepared = prepareDraft(await withServerFilledFields(n, content), n, pull.headSha);
    if (prepared.draft === undefined) {
      return errorResult({ ok: false, errors: prepared.errors, next: [`write pr://${n}/draft 修正后再发布`] });
    }
    draft = prepared.draft;
  } else {
    const saved = await storedDraftOf(ctx.sessionId);
    if (saved === null) throw new Error(`没有已保存的草稿；先 write pr://${n}/draft，或在正文里给草稿 JSON。`);
    if (saved.prNumber !== n) {
      throw new Error(`已保存的草稿属于 PR #${saved.prNumber}，不能发布到 PR #${n}；先审目标 PR。`);
    }
    draft = saved;
  }
  if (draft.publishedUrl !== undefined) {
    return errorResult({
      ok: false,
      errors: [`草稿已发布：${draft.publishedUrl}`],
      next: [`read pr://${n}/draft 复核`, "重写草稿后再发布"],
    });
  }
  const marker = markerOf(ctx.sessionId, toolCallId);
  const unreviewed = await unreviewedSlices(ctx.sessionId, draft.headSha);
  if (unreviewed !== null && unreviewed.length > 0) {
    return errorResult({
      ok: false,
      errors: [`还有 ${unreviewed.length} 片没有子代理跑过：${unreviewed.join("、")}。`],
      next: [
        "重新 delegate 这些片后重写草稿",
        '内容确与已审片相同的，写 skipped:[{slice,reason:"identical",identicalTo}] 再保存',
      ],
    });
  }
  const existing = (await gh.listReviews(n)).find((review) => review.body.includes(marker));
  if (existing) return jsonResult({ ok: true, deduped: true, url: existing.htmlUrl });
  const meta = await reviewMeta(serverGraphql, n);
  if (meta?.pendingReviewId !== null && meta?.pendingReviewId !== undefined) {
    return errorResult({
      ok: false,
      errors: ["PR 上已有待提交的 Review；先提交或清理后再发布草稿。"],
      next: [`write pr://${n}/review/submit 提交待审评论`, `read pr://${n}/threads 查看待审线程`],
    });
  }
  let url: string;
  try {
    ({ url } = await publishDraft(draft, { event: eventOf(uri, draft), marker }));
  } catch (err) {
    return errorResult({
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      next: [`read pr://${n}/draft 检查 head 与校验结果`],
    });
  }
  const saved = await markPublishedOf(n, ctx.sessionId, draft, url);
  invalidateThreads(n);
  await ctx.onDraftSaved?.(saved);
  return jsonResult({ ok: true, url, comments: saved.comments.length, next: [`read pr://${n}/draft 复核已发布状态`] });
}

async function writeReviewSubmit(uri: PrParts, content: string | undefined, ctx: WriteSession, toolCallId: string) {
  const n = uri.number;
  let input: SubmitInput;
  try {
    input = parseSubmit(content);
  } catch (err) {
    return errorResult({
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      next: [`正文给 {"event":"COMMENT|APPROVE|REQUEST_CHANGES","body":"总结"}`],
    });
  }
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
  invalidateThreads(n);
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
  invalidateThreads(uri.number);
  return jsonResult({ ok: true, url: comment.htmlUrl });
}

/** 手册 PR 的冻结词常出现在 md 正文里，lang 包里根本没有。 */
async function manualTextOf(n: number): Promise<string> {
  try {
    const pairs = (await specialPairs(n)).filter((entry) => entry.kind === "pair");
    if (pairs.length === 0) return "";
    const items = await specialContents(n, pairs.map((entry) => entry.key), prdata.fileSource(n));
    return items
      .flatMap((item) => (item.kind === "pair" ? [item.en.head ?? "", item.zh.head ?? ""] : []))
      .join("\n");
  } catch {
    return "";
  }
}

async function writeTerms(uri: PrParts, content: string | undefined): Promise<WriteResult> {
  if (content === undefined || content.trim() === "") throw new Error("术语表需要正文：{terms:[…]}。");
  const pack = await loadPack(uri.number);
  const parsed = parseTermInput(content, uri.number, pack.headSha);
  if (parsed.table === undefined) return errorResult({ ok: false, errors: parsed.errors });
  const errors = validateTermTable(parsed.table, pack, await manualTextOf(uri.number));
  if (errors.length > 0) {
    return errorResult({ ok: false, errors, next: [`按 errors 修正后重写 pr://${uri.number}/terms`] });
  }
  await saveTermTable(parsed.table);
  return jsonResult({
    ok: true,
    saved: `pr://${uri.number}/terms`,
    head: pack.headSha.slice(0, 7),
    counts: termCounts(parsed.table.terms),
    next: [`write pr://${uri.number}/pack {}`, `read pr://${uri.number}/terms?candidates=1`],
  });
}

export type WriteResult = AgentToolResult<Record<string, unknown>>;

export async function writePr(
  uri: PrParts,
  target: WriteTarget,
  content: string | undefined,
  ctx: WriteSession,
  toolCallId: string,
): Promise<WriteResult> {
  if (target.id !== "pr-draft" && target.id !== "pr-pack" && target.id !== "pr-terms") {
    assertCanWrite(ctx);
    assertBotWrites();
  }
  switch (target.id) {
    case "pr-draft":
      return writeDraft(uri, content, ctx);
    case "pr-terms":
      return writeTerms(uri, content);
    case "pr-pack": {
      const body = content?.trim() ?? "";
      if (body !== "" && body !== "{}") {
        return errorResult({
          error: "pr://<n>/pack 不接受参数；片大小由服务端按预算切",
          hint: "用 write pr://<n>/pack {}",
        });
      }
      return jsonResult(await writeWorkPack(uri.number, ctx.sessionId));
    }
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
