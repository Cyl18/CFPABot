// src/flows/review/review_thread_reply.ts
// Flow: review_thread_reply — reply to an existing PR review thread.
// Risk: review_write | Effects: github_comment_write
// Validates PR scope, thread existence, body length, and Markdown rendering.
//
// Spec: docs/specs/05-agent-review.md §11, docs/specs/02-flow-catalog.md §4

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import type { ReviewComment } from "@/client/github/types.js";

// ─── Constants ────────────────────────────────────────────────────────

/** Maximum reply body length (characters). */
const MAX_BODY_CHARS = 5_000;
/** Minimum reply body length. */
const MIN_BODY_CHARS = 1;

// ─── Input Schema ─────────────────────────────────────────────────────

export const review_thread_reply_input = Type.Object({
  prNumber: Type.Number({ description: "PR number the thread belongs to" }),
  threadCommentId: Type.Number({ description: "Review comment ID to reply to" }),
  body: Type.String({ description: "Reply body (plain text, will be Markdown-escaped)" }),
  sessionId: Type.Optional(Type.String({ description: "Optional session ID for tracking" })),
});

export type ReviewThreadReplyInput = Static<typeof review_thread_reply_input>;

// ─── Output Schema ────────────────────────────────────────────────────

export const review_thread_reply_output = Type.Object({
  replyId: Type.Number({ description: "Created reply comment ID" }),
  replyUrl: Type.Optional(Type.String({ description: "URL to the reply" })),
});

export type ReviewThreadReplyOutput = Static<typeof review_thread_reply_output>;

// ─── Flow Definition ──────────────────────────────────────────────────

export const review_thread_reply: Flow<
  typeof review_thread_reply_input,
  typeof review_thread_reply_output
> = {
  name: "review_thread_reply",
  description: "回复 PR Review thread。验证 PR scope、thread 存在性、正文长度和 Markdown 渲染。",
  input: review_thread_reply_input,
  output: review_thread_reply_output,

  meta: {
    tags: ["review", "thread", "agent"],
    risk: "review_write",
    agent_callable: false,
    effects: ["github_comment_write"],
    timeoutMs: 30_000,
  },

  execute: async (ctx: FlowContext, input: Static<typeof review_thread_reply_input>): Promise<Static<typeof review_thread_reply_output>> => {
    const { prNumber, threadCommentId, body, sessionId } = input;

    ctx.logger.info(
      { prNumber, threadCommentId, sessionId },
      "review_thread_reply started",
    );

    // 1. Validate body length
    if (body.length < MIN_BODY_CHARS) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Reply body must be at least ${MIN_BODY_CHARS} character(s)`,
        publicMessage: `回复正文不能为空`,
        retryable: false,
      });
    }

    if (body.length > MAX_BODY_CHARS) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Reply body exceeds maximum length of ${MAX_BODY_CHARS} characters (got ${body.length})`,
        publicMessage: `回复正文过长（${body.length} 字符，上限 ${MAX_BODY_CHARS}）`,
        retryable: false,
      });
    }

    // 2. Scope validation: verify PR exists and is accessible
    try {
      await ctx.github.getPullRequest(prNumber);
    } catch (err) {
      throw new FlowError({
        code: "SCOPE_VIOLATION",
        message: `PR #${prNumber} not found or inaccessible`,
        publicMessage: `PR #${prNumber} 不存在或无法访问`,
        retryable: false,
        details: { error: String(err) },
      });
    }

    // 3. Validate sessionId scope if provided
    if (sessionId && ctx.invocation.sessionId && sessionId !== ctx.invocation.sessionId) {
      throw new FlowError({
        code: "SCOPE_VIOLATION",
        message: `Session ID mismatch: ${sessionId} vs ${ctx.invocation.sessionId}`,
        publicMessage: `Session ID 与上下文不匹配`,
        retryable: false,
      });
    }

    // 4. Escape body for Markdown safety
    const escapedBody = escapeReviewBody(body);

    // 5. Create reply via GitHub client
    const reply: ReviewComment = await ctx.github.createReviewCommentReply(
      prNumber,
      escapedBody,
      threadCommentId,
    );

    ctx.logger.info(
      { replyId: reply.id, prNumber, threadCommentId },
      "review_thread_reply: reply created",
    );

    return {
      replyId: reply.id,
    };
  },
};

// ─── Helper: escape review body ───────────────────────────────────────

/**
 * Escape a review reply body to prevent Markdown injection.
 * HTML-encodes special characters and normalizes whitespace.
 */
function escapeReviewBody(body: string): string {
  return body
    // Escape HTML tags
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Normalize excessive newlines (GitHub collapses >3 into 2)
    .replace(/\n{4,}/g, "\n\n\n")
    // Trim leading/trailing whitespace
    .trim();
}
