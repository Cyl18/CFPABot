// src/client/github/index.ts
// Barrel exports for the GitHub outbound adapter.

import { createUserOctokit } from "@/client/github-app-auth.js";
import { createGitHubClient } from "./octokit-client.js";
import type { GitHubClient } from "./types.js";
import type { Logger } from "../../types.js";

// Per-token client cache. authMiddleware validates the cookie on every
// request and the route then builds another FlowContext — without a cache
// that is two Octokit instances + hook stacks per API call. Tokens are
// short-lived cookies; a bounded insertion-order LRU prevents unbounded
// growth for long-lived processes.
const userClientCache = new Map<string, GitHubClient>();
const USER_CLIENT_CACHE_MAX = 500;

/**
 * Create (or reuse) a GitHubClient backed by Octokit with a user OAuth token.
 * Replaces the raw-fetch user-token-client.ts implementation.
 */
export function createUserTokenGitHubClient(token?: string, logger?: Logger): GitHubClient {
  if (!token) {
    throw new Error("GitHub OAuth token is required for user-scoped requests");
  }
  const cached = userClientCache.get(token);
  if (cached) return cached;

  const client = createGitHubClient(createUserOctokit(token, logger), undefined, logger);
  if (userClientCache.size >= USER_CLIENT_CACHE_MAX) {
    const oldest = userClientCache.keys().next();
    if (!oldest.done) userClientCache.delete(oldest.value);
  }
  userClientCache.set(token, client);
  return client;
}

export { createGitHubClient } from "./octokit-client.js";
export { exchangeOAuthCode, buildRawUrl, buildRawBlobUrl, fetchRawContent, checkRawExists, PR_PACKER_NAME } from "./helpers.js";

export type { GitHubClient } from "./types.js";
export type {
  GitHubUser,
  Artifact,
  PullRequest,
  PullRequestSummary,
  PullRequestListItem,
  PullRequestFile,
  IssueComment,
  RateLimit,
  WorkflowRun,
  CreateCheckRunOptions,
  ListPullsPageOptions,
  ListAllPullsOptions,
  SearchIssueItem,
  SearchIssueResult,
  GitTreeEntry,
  CreateReviewOptions,
  CreateReviewResult,
  ReviewComment,
} from "./types.js";
