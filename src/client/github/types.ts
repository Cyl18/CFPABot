// src/client/github/types.ts
// Domain types + unified GitHubClient interface.
// All three implementations (Octokit, UserToken, Mock) satisfy this interface.

export interface GitHubUser {
  login: string;
  id: number;
}

/** Workflow artifact metadata */
export interface Artifact {
  id: number;
  name: string;
  size: number;

  /** API URL for downloading the artifact archive */
  archive_download_url: string;
}

export interface PullRequestSummary {
  number: number;
  html_url: string;
  state: "open" | "closed";
  user: { login: string; id: number } | null;
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  /** Whether the PR is a draft */
  draft?: boolean;
  head: {
    sha: string;
    ref: string;
    repo: { owner: { login: string } | null };
  };
  base: { ref: string; sha?: string };
  user: { login: string; id: number; email?: string } | null;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  /** Previous filename for renamed files (GitHub API field). */
  previous_filename?: string;
}

export interface IssueComment {
  id: number;
  body: string;
  html_url?: string;
  user: { login: string; id: number } | null;
}

export interface RateLimit {
  resources: {
    core: { limit: number; remaining: number; reset: number };
  };
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  check_suite_id: number;
  artifacts_url: string;
  html_url: string;
}

export interface CreateCheckRunOptions {
  name: string;
  sha: string;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required";
  output?: { title: string; summary: string; text?: string };
}

/** Options for listing a single page of PRs. */
export interface ListPullsPageOptions {
  page: number;
  perPage?: number;
  state?: "open" | "closed" | "all";
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
}

/** Options for listing all PRs (paginated internally). */
export interface ListAllPullsOptions {
  state?: "open" | "closed" | "all";
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
  perPage?: number;
}
/** Enriched PR summary for list views (more fields than PullRequestSummary). */
export interface PullRequestListItem {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  user: { login: string; id: number } | null;
  labels: Array<{ name: string; color?: string }>;
  created_at: string;
  updated_at: string;
  /** head.sha is available from the pulls list API; use for headSha skip checks. */
  head?: { sha: string };
  draft?: boolean;
}


export interface SearchIssueItem {
  number: number;
  title: string;
  html_url: string;
  state: string;
  user: { login: string } | null;
  labels: Array<{ name: string; color?: string }>;
  created_at: string;
  pull_request?: { merged_at?: string } | null;
  closed_at?: string | null;
}

export interface SearchIssueResult {
  totalCount: number;
  items: SearchIssueItem[];
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

// ─── Pull Request Review ──────────────────────────────────────────

/** Options for creating a pull request review. */
export interface CreateReviewOptions {
  commitId: string;
  body: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  comments: Array<{
    path: string;
    line?: number;
    side?: "LEFT" | "RIGHT";
    body: string;
  }>;
}

/** Result of creating a pull request review. */
export interface CreateReviewResult {
  id: number;
  body: string;
}

/** A pull request review comment within a review. */
export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  user: { login: string; id: number } | null;
  createdAt: string;
  replyTo?: number;
  pullRequestReviewId?: number;
}

// ─── Unified GitHubClient interface ──────────────────────────────────

export interface GitHubClient {
  listPullsPage(options: ListPullsPageOptions): Promise<PullRequestListItem[]>;
  listAllPulls(options?: ListAllPullsOptions): Promise<PullRequestListItem[]>;
  getPullRequest(prId: number): Promise<PullRequest>;
  getPullRequestFiles(prId: number): Promise<PullRequestFile[]>;
  getPullRequestDiff(prId: number): Promise<string>;
  searchPulls(query: string): Promise<PullRequestSummary[]>;
  findPrFromHeadRef(headRef: string): Promise<PullRequestSummary>;

  // ── Issues / Comments ──
  getPrComments(prId: number): Promise<IssueComment[]>;
  createIssueComment(prId: number, body: string): Promise<IssueComment>;
  updateIssueComment(commentId: number, body: string): Promise<IssueComment>;
  getBotComments(prId: number, botLogin?: string): Promise<IssueComment[]>;
  findBotComment(prId: number, botLogin?: string): Promise<IssueComment | null>;

  // ── Labels ──
  addLabels(prId: number, labels: string[]): Promise<void>;
  removeLabels(prId: number, labels: string[]): Promise<void>;
  syncLabels(prId: number, desired: string[], current: string[]): Promise<void>;

  // ── Checks / Workflows ──
  createCheckRun(opts: CreateCheckRunOptions): Promise<void>;
  getWorkflowRun(checkSuiteId: number): Promise<WorkflowRun>;
  approveWorkflowRun(runId: number): Promise<void>;
  /** Find workflow runs for a PR head SHA, optionally filtered by workflow name.
   *  Returns runs sorted newest-first. Empty array when no runs match. */
  findWorkflowRunsByHeadSha(
    headSha: string,
    workflowName?: string,
  ): Promise<WorkflowRun[]>;
  getArtifactsFromWorkflow(runId: number): Promise<Artifact[]>;

  // ── Users ──
  getUser(): Promise<{ login: string; id: number }>;
  /** Fetch a GitHub user's numeric ID by their login. */
  getUserByLogin(login: string): Promise<{ id: number; login: string }>;

  checkCollaborator(username: string): Promise<boolean>;

  // ── Search ──
  searchIssues(query: string): Promise<SearchIssueResult>;

  // ── Rate Limit ──
  getRateLimit(): Promise<RateLimit>;

  // ── Gist ──
  createGist(content: string, name: string): Promise<{ id: string; html_url: string }>;

  // ── Git Data ──
  getGitTree(ref: string, recursive?: boolean): Promise<GitTreeEntry[]>;

  // ── File Content ──
  fetchFileContent(path: string, ref: string): Promise<Record<string, string> | null>;

  // ── Pull Request Review ──
  /** Create a pull request review of event type COMMENT/APPROVE/REQUEST_CHANGES. */
  createReview(prNumber: number, opts: CreateReviewOptions): Promise<CreateReviewResult>;
  /** List review comments for a PR, optionally filtered by review id. */
  listReviewComments(prNumber: number, reviewId?: number): Promise<ReviewComment[]>;
  /** Create a reply to an existing pull request review comment. */
  createReviewCommentReply(prNumber: number, body: string, commentId: number): Promise<ReviewComment>;
}
