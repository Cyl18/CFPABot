import { Hono } from "hono";
import { z } from "zod";
import { gh, serverGraphql, userGraphql } from "../github/client.ts";
import type { GhOctokit } from "../github/client.ts";
import {
  addReviewThread,
  anonymousReviewState,
  createPendingReview,
  createSubmittedReview,
  deleteReviewComment,
  renderComments,
  replyToReviewThread,
  reviewMeta,
  setFileViewed,
  setThreadResolved,
  submitPendingReview,
  userReviewState,
} from "../github/review.ts";
import { httpStatus } from "../github/mappers.ts";
import { inHunks } from "../domain/diff.ts";
import { commentableHunks } from "../review.ts";
import { prdata } from "../prdata.ts";
import { currentUser, requireUserToken } from "./auth.ts";
import type { AppContext, AppEnv } from "./auth.ts";
import { HttpError, notFound, parseBody } from "./errors.ts";
import { prNumber, withPull } from "./routes-pr.ts";
import type {
  AddReviewCommentRequest,
  AddReviewReplyRequest,
  PrReviewState,
  ReviewHtmlRequest,
  ReviewThread,
  SetFileViewedRequest,
  SetThreadResolvedRequest,
  SubmitReviewRequest,
} from "../../shared/api.ts";

export const reviewRoutes = new Hono<AppEnv>();

const REAUTH = "需要重新登录 GitHub 授权评论权限";
const NOT_IN_DIFF = "这一行不在 PR 的改动范围内，GitHub 不允许在这里评论";

const commentSchema = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().min(1),
  body: z.string().min(1).max(65_536),
});

const viewedSchema = z.object({
  path: z.string().min(1),
  viewed: z.boolean(),
});

const submitSchema = z.object({
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
  body: z.string().max(65_536).default(""),
});

const resolveSchema = z.object({
  resolved: z.boolean(),
});

const replySchema = z.object({
  body: z.string().min(1).max(65_536),
});

const htmlSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(300),
});

function graphqlErrors(err: unknown): { types: string[]; messages: string[] } {
  const types: string[] = [];
  const messages: string[] = [];
  if (err === null || typeof err !== "object" || !("errors" in err)) return { types, messages };
  const errors = err.errors;
  if (!Array.isArray(errors)) return { types, messages };
  for (const item of errors) {
    if (item === null || typeof item !== "object") continue;
    if ("type" in item && typeof item.type === "string") types.push(item.type);
    if ("message" in item && typeof item.message === "string") messages.push(item.message);
  }
  return { types, messages };
}

async function runReview<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const { types, messages } = graphqlErrors(err);
    const message = messages.length > 0 ? messages.join("; ") : null;
    if (httpStatus(err) === 401 || types.includes("FORBIDDEN") || types.includes("INSUFFICIENT_SCOPES")) {
      throw new HttpError(401, message ?? REAUTH, "reauth");
    }
    if (types.length > 0 || messages.length > 0) {
      throw new HttpError(422, message ?? "GitHub 拒绝了这次操作", "github");
    }
    throw err;
  }
}

function requirePull<T>(value: T | null): T {
  if (value === null) throw notFound("PR 不存在");
  return value;
}

async function reviewState(c: AppContext, n: number): Promise<PrReviewState | null> {
  const token = c.get("token");
  try {
    if (!currentUser(c) || !token) return await anonymousReviewState(serverGraphql, n);
    try {
      return await userReviewState(userGraphql(token), n);
    } catch (err) {
      if (httpStatus(err) !== 401) throw err;
      return await anonymousReviewState(serverGraphql, n);
    }
  } catch (err) {
    if (graphqlErrors(err).types.includes("NOT_FOUND")) throw notFound("PR 不存在");
    throw err;
  }
}

async function createReviewComment(
  octokit: GhOctokit,
  n: number,
  input: AddReviewCommentRequest,
): Promise<ReviewThread | null> {
  const { pull, files } = await prdata.files(n);
  const file = files.find((entry) => entry.path === input.path);
  if (file === undefined || file.status === "removed") throw new HttpError(422, NOT_IN_DIFF, "not_in_diff");
  const headText =
    file.patch === undefined && file.status === "added" ? await gh.getFile(input.path, pull.headSha) : null;
  if (!inHunks(input.line, commentableHunks(file, headText))) {
    throw new HttpError(422, NOT_IN_DIFF, "not_in_diff");
  }

  const meta = await reviewMeta(octokit, n);
  if (meta === null) return null;
  let reviewId = meta.pendingReviewId;
  if (reviewId === null) {
    try {
      reviewId = await createPendingReview(octokit, meta.pullRequestId, meta.headSha);
    } catch (err) {
      const retry = await reviewMeta(octokit, n);
      reviewId = retry?.pendingReviewId ?? null;
      if (reviewId === null) throw err;
    }
  }
  return addReviewThread(
    octokit,
    { reviewId, path: input.path, line: input.line, body: input.body },
    meta.viewer,
  );
}

reviewRoutes.get("/prs/:n/review", async (c) => {
  const n = prNumber(c);
  return c.json(requirePull(await withPull(() => reviewState(c, n))));
});

reviewRoutes.post("/prs/:n/review/html", async (c) => {
  const input = await parseBody<ReviewHtmlRequest>(c, htmlSchema);
  prNumber(c);
  return c.json({ html: await runReview(() => renderComments(serverGraphql, input.ids)) });
});

reviewRoutes.post("/prs/:n/review/comments", async (c) => {
  const token = requireUserToken(c);
  const input = await parseBody<AddReviewCommentRequest>(c, commentSchema);
  const n = prNumber(c);
  const octokit = userGraphql(token);
  const thread = requirePull(await withPull(() => runReview(() => createReviewComment(octokit, n, input))));
  return c.json(thread);
});

reviewRoutes.delete("/prs/:n/review/comments/:id", async (c) => {
  const token = requireUserToken(c);
  prNumber(c);
  await runReview(() => deleteReviewComment(userGraphql(token), c.req.param("id")));
  return c.body(null, 204);
});

reviewRoutes.put("/prs/:n/review/threads/:id/resolved", async (c) => {
  const token = requireUserToken(c);
  const input = await parseBody<SetThreadResolvedRequest>(c, resolveSchema);
  prNumber(c);
  await runReview(() => setThreadResolved(userGraphql(token), c.req.param("id"), input.resolved));
  return c.body(null, 204);
});

reviewRoutes.post("/prs/:n/review/threads/:id/replies", async (c) => {
  const token = requireUserToken(c);
  const input = await parseBody<AddReviewReplyRequest>(c, replySchema);
  prNumber(c);
  const comment = await runReview(() =>
    replyToReviewThread(userGraphql(token), c.req.param("id"), input.body, currentUser(c)?.login ?? null),
  );
  return c.json(comment);
});

reviewRoutes.put("/prs/:n/review/viewed", async (c) => {
  const token = requireUserToken(c);
  const input = await parseBody<SetFileViewedRequest>(c, viewedSchema);
  const n = prNumber(c);
  const octokit = userGraphql(token);
  const meta = requirePull(await runReview(() => reviewMeta(octokit, n)));
  await runReview(() => setFileViewed(octokit, meta.pullRequestId, input.path, input.viewed));
  return c.body(null, 204);
});

reviewRoutes.post("/prs/:n/review/submit", async (c) => {
  const token = requireUserToken(c);
  const input = await parseBody<SubmitReviewRequest>(c, submitSchema);
  const n = prNumber(c);
  const octokit = userGraphql(token);
  const meta = requirePull(await runReview(() => reviewMeta(octokit, n)));
  const url = await runReview(async () => {
    if (meta.pendingReviewId !== null) {
      return submitPendingReview(octokit, meta.pendingReviewId, input.event, input.body);
    }
    if (input.event === "COMMENT" && input.body.trim() === "") {
      throw new HttpError(422, "没有待提交的评论，也没有填写总结", "empty_review");
    }
    return createSubmittedReview(octokit, meta.pullRequestId, meta.headSha, input.event, input.body);
  });
  return c.json({ url });
});
