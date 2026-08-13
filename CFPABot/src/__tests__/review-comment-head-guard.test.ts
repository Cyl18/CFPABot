// src/__tests__/review-comment-head-guard.test.ts
// 契约测试: review_comment 的过期发表防护 (expectedHeadSha)。
// - head 匹配 → 正常发表
// - head 不匹配 → FlowError STALE_HEAD, 不调用 createIssueComment
// - 不传 expectedHeadSha → 无校验(向后兼容)

import { describe, expect, test } from "bun:test";
import { createMockContext } from "./helpers/mock-context.js";
import { review_comment } from "../flows/review/review_comment.js";
import { FlowError } from "../types.js";

function mockGitHub(headSha: string | null) {
  const calls: string[] = [];
  const github = {
    getPullRequest: async () => ({ number: 1, head: headSha ? { sha: headSha } : undefined }),
    createIssueComment: async () => {
      calls.push("createIssueComment");
      return { id: 99, body: "x", html_url: "https://github.com/x" };
    },
  } as never;
  return { github, calls };
}

describe("review_comment 过期发表防护", () => {
  test("head 匹配 → 正常发表", async () => {
    const { github, calls } = mockGitHub("abc123");
    const ctx = createMockContext({ github });
    const out = await review_comment.execute(ctx, {
      prNumber: 1,
      body: "审查通过",
      expectedHeadSha: "abc123",
    });
    expect(out.commentId).toBe(99);
    expect(calls).toEqual(["createIssueComment"]);
  });

  test("head 不匹配 → STALE_HEAD 拒绝, 不发表", async () => {
    const { github, calls } = mockGitHub("newsha999");
    const ctx = createMockContext({ github });
    const err = await review_comment
      .execute(ctx, { prNumber: 1, body: "基于旧 head 的意见", expectedHeadSha: "abc123" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).code).toBe("STALE_HEAD");
    expect(calls).toEqual([]); // createIssueComment 从未被调用
  });

  test("不传 expectedHeadSha → 向后兼容, 正常发表", async () => {
    const { github, calls } = mockGitHub("whatever");
    const ctx = createMockContext({ github });
    const out = await review_comment.execute(ctx, { prNumber: 1, body: "兼容路径" });
    expect(out.commentId).toBe(99);
    expect(calls).toEqual(["createIssueComment"]);
  });

  test("PR 无 head 信息且传了 expectedHeadSha → STALE_HEAD", async () => {
    const { github, calls } = mockGitHub(null);
    const ctx = createMockContext({ github });
    const err = await review_comment
      .execute(ctx, { prNumber: 1, body: "x", expectedHeadSha: "abc123" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as FlowError).code).toBe("STALE_HEAD");
    expect(calls).toEqual([]);
  });

  test("agent 调用不带 expectedHeadSha → INVALID_INPUT 拒绝, 不发表", async () => {
    const { github, calls } = mockGitHub("abc123");
    const ctx = createMockContext({
      github,
      invocation: { id: "test-inv-agent", source: "agent" as const },
    });
    const err = await review_comment
      .execute(ctx, { prNumber: 1, body: "意见" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]); // createIssueComment 从未被调用
  });

  test("REVIEW_PUBLISH_ENABLED=false → REVIEW_PUBLISH_DISABLED 拒绝, 不发表", async () => {
    const { github, calls } = mockGitHub("abc123");
    const ctx = createMockContext({
      github,
      config: { ...createMockContext({ github }).config, reviewPublishEnabled: false },
    });
    const err = await review_comment
      .execute(ctx, { prNumber: 1, body: "意见", expectedHeadSha: "abc123" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).code).toBe("REVIEW_PUBLISH_DISABLED");
    expect(calls).toEqual([]);
  });
});
