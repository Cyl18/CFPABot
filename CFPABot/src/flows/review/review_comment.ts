// src/flows/review/review_comment.ts
// Flow: review_comment — post a single PR issue comment (Mode A, NOT inline).
// Risk: repository_write | Effects: github_comment_write
// The agent reads ctx.draft/reviews to compose the body, then calls this
// tool to post it. Posting to a public PR requires admin confirmation via
// flow-adapter (see meta below).

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import type { IssueComment, PullRequest } from "@/client/github/types.js";

// ─── Constants ────────────────────────────────────────────────────────

const MAX_BODY_CHARS = 65_536; // GitHub issue comment limit
const MIN_BODY_CHARS = 1;

// ─── Input Schema ─────────────────────────────────────────────────────

export const review_comment_input = Type.Object({
  prNumber: Type.Number({ description: "PR number to comment on" }),
  body: Type.String({ description: "Comment body (Markdown). Agent should compose from ctx.draft/reviews." }),
  expectedHeadSha: Type.Optional(
    Type.String({ description: "发表前校验的期望 head SHA（来自 ctx.pr.headSha）。不匹配则拒绝发表（STALE_HEAD）—— 防止基于过期审查结果发布评论。" }),
  ),
});

export type ReviewCommentInput = Static<typeof review_comment_input>;

// ─── Output Schema ────────────────────────────────────────────────────

export const review_comment_output = Type.Object({
  commentId: Type.Number(),
  body: Type.String(),
  htmlUrl: Type.Optional(Type.String()),
});

export type ReviewCommentOutput = Static<typeof review_comment_output>;

// ─── Flow Definition ──────────────────────────────────────────────────

export const review_comment: Flow<typeof review_comment_input, typeof review_comment_output> = {
  name: "review_comment",
  description:
    "在 PR 上发布一条 issue comment（Mode A，非 inline）。agent 应先从 ctx.draft/reviews 读取审查结论，组合成正文后调用本工具。正文长度上限 65536 字符。",
  input: review_comment_input,
  output: review_comment_output,

  meta: {
    tags: ["review", "comment", "agent"],
    // repository_write: 发表到公开 PR 是仓库写操作, agent 调用必须经 admin 确认。
    // (曾为 review_write → flow-adapter 自动执行, 导致验证会话直接发表到公开 PR)
    risk: "repository_write",
    agent_callable: true,
    effects: ["github_comment_write"],
    timeoutMs: 30_000,
  },

  execute: async (ctx: FlowContext, input: Static<typeof review_comment_input>): Promise<Static<typeof review_comment_output>> => {
    const { prNumber, body, expectedHeadSha } = input;

    // 发表总开关(契约 REVIEW_PUBLISH_ENABLED, 默认 false): 未启用时仅产生审查结果。
    if (!ctx.config.reviewPublishEnabled) {
      throw new FlowError({
        code: "REVIEW_PUBLISH_DISABLED",
        message: "review_comment: publish disabled (REVIEW_PUBLISH_ENABLED != true)",
        publicMessage: "审查发表已禁用(REVIEW_PUBLISH_ENABLED 未开启)，本次仅产生审查结果，未写入 GitHub",
        retryable: false,
      });
    }

    // Agent 调用必须带 expectedHeadSha（契约 2026-08-01: 发表前必须校验 head）。
    // API/Webhook 等非 agent 调用不受限（向后兼容，防护由调用方负责）。
    if (ctx.invocation.source === "agent" && !expectedHeadSha) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: "review_comment: expectedHeadSha is required for agent invocations",
        publicMessage: "agent 发表评论必须提供 expectedHeadSha（取自 ctx.pr.headSha）— 防止基于过期审查结果发布评论",
        retryable: false,
      });
    }

    ctx.logger.info({ prNumber, bodyLen: body.length, expectedHeadSha }, "review_comment started");

    // Scope validation: verify PR exists and is accessible
    let pr: PullRequest;
    try {
      pr = await ctx.github.getPullRequest(prNumber);
    } catch (err) {
      throw new FlowError({
        code: "SCOPE_VIOLATION",
        message: `PR #${prNumber} not found or inaccessible`,
        publicMessage: `PR #${prNumber} 不存在或无法访问`,
        retryable: false,
        details: { error: String(err) },
      });
    }

    // 过期发表防护 (契约 2026-08-01): 提供 expectedHeadSha 时校验 PR 当前 head。
    if (expectedHeadSha) {
      const currentHead = pr.head?.sha;
      if (currentHead !== expectedHeadSha) {
        throw new FlowError({
          code: "STALE_HEAD",
          message: `PR head changed: expected ${expectedHeadSha}, got ${currentHead ?? "unknown"}`,
          publicMessage: `PR 的 head 已变更（当前 ${(currentHead ?? "unknown").slice(0, 7)}，审查基于 ${expectedHeadSha.slice(0, 7)}）—— 需要重新审查后再发表`,
          retryable: false,
          details: { expectedHeadSha, currentHead },
        });
      }
    }

    if (body.length < MIN_BODY_CHARS) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Comment body must be at least ${MIN_BODY_CHARS} character(s)`,
        publicMessage: "评论正文不能为空",
        retryable: false,
      });
    }

    if (body.length > MAX_BODY_CHARS) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Comment body exceeds maximum length of ${MAX_BODY_CHARS} characters (got ${body.length})`,
        publicMessage: `评论正文过长（${body.length} 字符，上限 ${MAX_BODY_CHARS}）`,
        retryable: false,
      });
    }

    // Create issue comment via GitHub client
    const comment: IssueComment = await ctx.github.createIssueComment(prNumber, body);

    ctx.logger.info(
      { commentId: comment.id, prNumber },
      "review_comment: issue comment created",
    );

    return {
      commentId: comment.id,
      body: comment.body,
      htmlUrl: comment.html_url,
    };
  },
};
