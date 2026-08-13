// src/client/github/index.ts
// Barrel exports for the GitHub outbound adapter.

import { createUserOctokit } from "@/client/github-app-auth.js";
import { createGitHubClient } from "./octokit-client.js";
import type { GitHubClient } from "./types.js";
import type { Logger } from "../../types.js";

/**
 * Create a GitHubClient backed by Octokit with user OAuth token.
 * Replaces the raw-fetch user-token-client.ts implementation.
 */
export function createUserTokenGitHubClient(token?: string, logger?: Logger): GitHubClient {
  return createGitHubClient(createUserOctokit(token, logger));
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
