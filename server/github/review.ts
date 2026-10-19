import { repo } from "../env.ts";
import { inHunks } from "../domain/diff.ts";
import { HttpError } from "../http/errors.ts";
import { prdata } from "../prdata.ts";
import { commentableHunks } from "../review.ts";
import { gh } from "./client.ts";
import type { GhOctokit } from "./client.ts";
import type {
  FileViewedState,
  PrReviewState,
  ReviewComment,
  ReviewEvent,
  ReviewThread,
} from "../../shared/api.ts";

const PAGE_SIZE = 100;

const COMMENT_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { id author { login avatarUrl } body createdAt url state }
`;

const RENDER_COMMENTS = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequestReviewComment { id bodyHTML }
  }
}`;

const THREAD_FIELDS = `
  id
  path
  line
  originalLine
  isOutdated
  isResolved
  comments(first: ${PAGE_SIZE}) {${COMMENT_FIELDS}}
`;

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {${THREAD_FIELDS}}
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query($threadId: ID!, $cursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: ${PAGE_SIZE}, after: $cursor) {${COMMENT_FIELDS}}
    }
  }
}`;

const META_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      headRefOid
      reviews(last: ${PAGE_SIZE}, states: [PENDING]) { nodes { id author { login } } }
    }
  }
}`;

const FILES_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

const CREATE_PENDING_REVIEW = `
mutation($pullRequestId: ID!, $commitOID: GitObjectID!) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, commitOID: $commitOID}) {
    pullRequestReview { id }
  }
}`;

const CREATE_REVIEW = `
mutation($pullRequestId: ID!, $commitOID: GitObjectID!, $event: PullRequestReviewEvent!, $body: String) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, commitOID: $commitOID, event: $event, body: $body}) {
    pullRequestReview { url }
  }
}`;

const ADD_THREAD = `
mutation($pullRequestReviewId: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $pullRequestReviewId, path: $path, line: $line, side: RIGHT, body: $body}) {
    thread {${THREAD_FIELDS}}
  }
}`;

const DELETE_COMMENT = `
mutation($id: ID!) {
  deletePullRequestReviewComment(input: {id: $id}) { clientMutationId }
}`;

const MARK_VIEWED = `
mutation($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: {pullRequestId: $pullRequestId, path: $path}) { clientMutationId }
}`;

const UNMARK_VIEWED = `
mutation($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: {pullRequestId: $pullRequestId, path: $path}) { clientMutationId }
}`;

const SUBMIT_REVIEW = `
mutation($pullRequestReviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {pullRequestReviewId: $pullRequestReviewId, event: $event, body: $body}) {
    pullRequestReview { url }
  }
}`;

const RESOLVE_THREAD = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}`;

const UNRESOLVE_THREAD = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}`;

const ADD_REPLY = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment {${COMMENT_FIELDS}}
  }
}`;

interface Actor {
  login: string;
  avatarUrl: string;
}

interface CommentNode {
  id: string;
  author: Actor | null;
  body: string;
  createdAt: string;
  url: string;
  state: string;
}

interface RenderNode {
  id: string;
  bodyHTML?: string;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CommentConnection {
  pageInfo: PageInfo;
  nodes: CommentNode[];
}

interface ThreadNode {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  isOutdated: boolean;
  isResolved: boolean;
  comments: CommentConnection;
}

interface ThreadsData {
  repository: {
    pullRequest: {
      headRefOid: string;
      reviewThreads: { pageInfo: PageInfo; nodes: ThreadNode[] };
    } | null;
  };
}

interface MetaData {
  viewer: Actor | null;
  repository: {
    pullRequest: {
      id: string;
      headRefOid: string;
      reviews: { nodes: { id: string; author: { login: string } | null }[] } | null;
    } | null;
  };
}

interface FilesData {
  repository: {
    pullRequest: {
      files: { pageInfo: PageInfo; nodes: { path: string; viewerViewedState: FileViewedState }[] };
    } | null;
  };
}

interface ReviewIdData {
  addPullRequestReview: { pullRequestReview: { id: string } | null };
}

interface ReviewUrlData {
  addPullRequestReview: { pullRequestReview: { url: string } | null };
}

interface SubmitData {
  submitPullRequestReview: { pullRequestReview: { url: string } | null };
}

interface ThreadData {
  addPullRequestReviewThread: { thread: ThreadNode };
}

interface ReplyData {
  addPullRequestReviewThreadReply: { comment: CommentNode };
}

export interface ReviewMeta {
  viewer: string | null;
  pullRequestId: string;
  headSha: string;
  pendingReviewId: string | null;
}

function mapComment(comment: CommentNode, viewer: string | null): ReviewComment {
  const login = comment.author?.login ?? null;
  return {
    id: comment.id,
    author: login ?? "ghost",
    avatarUrl: comment.author?.avatarUrl ?? "",
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
    pending: comment.state === "PENDING",
    mine: viewer !== null && login === viewer,
  };
}

function mapThread(node: ThreadNode, comments: CommentNode[], viewer: string | null): ReviewThread {
  return {
    id: node.id,
    path: node.path,
    line: node.line,
    originalLine: node.originalLine,
    outdated: node.isOutdated,
    resolved: node.isResolved,
    comments: comments.map((comment) => mapComment(comment, viewer)),
  };
}

interface ThreadCommentsData {
  node: { comments?: CommentConnection } | null;
}

export async function reviewMeta(octokit: GhOctokit, n: number): Promise<ReviewMeta | null> {
  const data: MetaData = await octokit.graphql(META_QUERY, { owner: repo.owner, name: repo.name, number: n });
  const pull = data.repository.pullRequest;
  if (pull === null) return null;
  const viewer = data.viewer?.login ?? null;
  const pending = (pull.reviews?.nodes ?? []).find(
    (review) => viewer !== null && review.author?.login === viewer,
  );
  return {
    viewer,
    pullRequestId: pull.id,
    headSha: pull.headRefOid,
    pendingReviewId: pending?.id ?? null,
  };
}

async function fetchThreadComments(
  octokit: GhOctokit,
  threadId: string,
  cursor: string | null,
): Promise<CommentNode[]> {
  const comments: CommentNode[] = [];
  let after = cursor;
  for (;;) {
    const data: ThreadCommentsData = await octokit.graphql(THREAD_COMMENTS_QUERY, {
      threadId,
      cursor: after,
    });
    const connection = data.node?.comments;
    if (connection === undefined) return comments;
    comments.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) return comments;
    after = connection.pageInfo.endCursor;
  }
}

async function fetchThreads(
  octokit: GhOctokit,
  n: number,
  viewer: string | null,
): Promise<{ headSha: string; threads: ReviewThread[] } | null> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  let headSha = "";
  for (;;) {
    const data: ThreadsData = await octokit.graphql(THREADS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: n,
      cursor,
    });
    const pull = data.repository.pullRequest;
    if (pull === null) return null;
    headSha = pull.headRefOid;
    for (const node of pull.reviewThreads.nodes) {
      const comments = [...node.comments.nodes];
      if (node.comments.pageInfo.hasNextPage) {
        comments.push(...(await fetchThreadComments(octokit, node.id, node.comments.pageInfo.endCursor)));
      }
      threads.push(mapThread(node, comments, viewer));
    }
    if (!pull.reviewThreads.pageInfo.hasNextPage || pull.reviewThreads.pageInfo.endCursor === null) break;
    cursor = pull.reviewThreads.pageInfo.endCursor;
  }
  return { headSha, threads };
}

async function fetchViewed(octokit: GhOctokit, n: number): Promise<Record<string, FileViewedState>> {
  const viewed: Record<string, FileViewedState> = {};
  let cursor: string | null = null;
  for (;;) {
    const data: FilesData = await octokit.graphql(FILES_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: n,
      cursor,
    });
    const connection = data.repository.pullRequest?.files;
    if (connection === undefined) return viewed;
    for (const file of connection.nodes) viewed[file.path] = file.viewerViewedState;
    if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) break;
    cursor = connection.pageInfo.endCursor;
  }
  return viewed;
}

export async function userReviewState(octokit: GhOctokit, n: number): Promise<PrReviewState | null> {
  const meta = await reviewMeta(octokit, n);
  if (meta === null) return null;
  const [threads, viewed] = await Promise.all([fetchThreads(octokit, n, meta.viewer), fetchViewed(octokit, n)]);
  if (threads === null) return null;
  return {
    viewer: meta.viewer,
    headSha: meta.headSha,
    pendingReviewId: meta.pendingReviewId,
    threads: threads.threads,
    viewed,
  };
}

export async function anonymousReviewState(octokit: GhOctokit, n: number): Promise<PrReviewState | null> {
  const result = await fetchThreads(octokit, n, null);
  if (result === null) return null;
  return { viewer: null, headSha: result.headSha, pendingReviewId: null, threads: result.threads, viewed: {} };
}

export async function createPendingReview(
  octokit: GhOctokit,
  pullRequestId: string,
  headSha: string,
): Promise<string> {
  const data: ReviewIdData = await octokit.graphql(CREATE_PENDING_REVIEW, {
    pullRequestId,
    commitOID: headSha,
    request: { retries: 0 },
  });
  const id = data.addPullRequestReview.pullRequestReview?.id;
  if (id === undefined) throw new Error("GitHub 未返回待提交审查 id");
  return id;
}

export async function addReviewThread(
  octokit: GhOctokit,
  input: { reviewId: string; path: string; line: number; body: string },
  viewer: string | null,
): Promise<ReviewThread> {
  const data: ThreadData = await octokit.graphql(ADD_THREAD, {
    pullRequestReviewId: input.reviewId,
    path: input.path,
    line: input.line,
    body: input.body,
    request: { retries: 0 },
  });
  const thread = data.addPullRequestReviewThread.thread;
  return mapThread(thread, thread.comments.nodes, viewer);
}

const NOT_IN_DIFF = "这一行不在 PR 的改动范围内，GitHub 不允许在这里评论";

export async function createReviewComment(
  octokit: GhOctokit,
  n: number,
  input: { path: string; line: number; body: string },
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
  return addReviewThread(octokit, { reviewId, path: input.path, line: input.line, body: input.body }, meta.viewer);
}

export async function deleteReviewComment(octokit: GhOctokit, commentId: string): Promise<void> {
  await octokit.graphql(DELETE_COMMENT, { id: commentId, request: { retries: 0 } });
}

export async function renderComments(octokit: GhOctokit, ids: readonly string[]): Promise<Record<string, string>> {
  const data: { nodes: RenderNode[] } = await octokit.graphql(RENDER_COMMENTS, { ids });
  const html: Record<string, string> = {};
  for (const node of data.nodes) {
    if (node.bodyHTML !== undefined) html[node.id] = node.bodyHTML;
  }
  return html;
}

export async function setThreadResolved(octokit: GhOctokit, threadId: string, resolved: boolean): Promise<void> {
  await octokit.graphql(resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId, request: { retries: 0 } });
}

export async function replyToReviewThread(
  octokit: GhOctokit,
  threadId: string,
  body: string,
  viewer: string | null,
): Promise<ReviewComment> {
  const data: ReplyData = await octokit.graphql(ADD_REPLY, { threadId, body, request: { retries: 0 } });
  return mapComment(data.addPullRequestReviewThreadReply.comment, viewer);
}

export async function setFileViewed(
  octokit: GhOctokit,
  pullRequestId: string,
  path: string,
  viewed: boolean,
): Promise<void> {
  await octokit.graphql(viewed ? MARK_VIEWED : UNMARK_VIEWED, {
    pullRequestId,
    path,
    request: { retries: 0 },
  });
}

export async function submitPendingReview(
  octokit: GhOctokit,
  reviewId: string,
  event: ReviewEvent,
  body: string,
): Promise<string> {
  const data: SubmitData = await octokit.graphql(SUBMIT_REVIEW, {
    pullRequestReviewId: reviewId,
    event,
    body,
    request: { retries: 0 },
  });
  const url = data.submitPullRequestReview.pullRequestReview?.url;
  if (url === undefined) throw new Error("GitHub 未返回审查链接");
  return url;
}

export async function createSubmittedReview(
  octokit: GhOctokit,
  pullRequestId: string,
  headSha: string,
  event: ReviewEvent,
  body: string,
): Promise<string> {
  const data: ReviewUrlData = await octokit.graphql(CREATE_REVIEW, {
    pullRequestId,
    commitOID: headSha,
    event,
    body,
    request: { retries: 0 },
  });
  const url = data.addPullRequestReview.pullRequestReview?.url;
  if (url === undefined) throw new Error("GitHub 未返回审查链接");
  return url;
}
