// src/api/frontend/dev/mock-github.ts
// Mock GitHub client — implements GitHubClient interface, captures outbound calls.
// Used by the Developer Panel to simulate webhook events without real GitHub API.

import type { GitHubClient, PullRequest, PullRequestFile, IssueComment, Artifact, PullRequestSummary, PullRequestListItem, RateLimit, WorkflowRun, SearchIssueResult, GitTreeEntry, CreateReviewResult, ReviewComment } from "@/client/github/index.js"

/** A single captured outbound call record */
export interface OutboundCall {
  id: number;
  timestamp: number;
  method: string;
  args: unknown[];
  /** Resolved value (JSON-serializable snapshot) */
  result?: unknown;
}

/** Mutable mock state shared across the dev module */
interface MockState {
  calls: OutboundCall[];
  nextId: number;
  /** Per-method mock overrides: method -> JSON result string */
  overrides: Map<string, unknown>;
  /** When true, dispatch() skips the GitHub App JWT → Installation Token flow entirely */
  active: boolean;
}

const state: MockState = {
  calls: [],
  nextId: 1,
  overrides: new Map(),
  active: false,
};

// ─── Default return values (per method) ────────────────────────────

const defaults: Record<string, () => unknown> = {
  getPullRequest: () => ({
    number: 0,
    html_url: "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/0",
    state: "open",
    head: { sha: "abc123mock", ref: "mock-branch", repo: { owner: { login: "mock-user" } } },
    base: { ref: "main" },
    user: { login: "mock-user", id: 1 },
  }),
  getPullRequestFiles: () => [],
  getPullRequestDiff: () => "",
  getPrComments: () => [],
  createIssueComment: () => ({ id: 900000 + state.nextId, body: "", user: { login: "cfpa-bot[bot]", id: 0 } }),
  updateIssueComment: () => ({ id: 0, body: "", user: { login: "cfpa-bot[bot]", id: 0 } }),
  checkCollaborator: () => true,
  getRateLimit: () => ({ resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } }),
  getWorkflowRun: () => ({ id: 0, status: "", conclusion: null, check_suite_id: 0, artifacts_url: "", html_url: "" }),
  findWorkflowRunsByHeadSha: () => [],
  approveWorkflowRun: () => undefined,
  addLabels: () => undefined,
  removeLabels: () => undefined,
  createCheckRun: () => undefined,
  searchPulls: () => [],
  createGist: () => ({ id: "mock-gist-id", html_url: "https://gist.github.com/mock/mock-gist-id" }),
  getBotComments: () => [],
  findBotComment: () => null,
  syncLabels: () => undefined,
  findPrFromHeadRef: () => ({ number: 0, html_url: "", state: "open", user: null }),
  getArtifactsFromWorkflow: () => [],
  listPullsPage: () => [],
  listAllPulls: () => [],
  searchIssues: () => ({ totalCount: 0, items: [] }),
  getUser: () => ({ login: "mock-user", id: 1 }),
  getUserByLogin: () => ({ id: 1, login: "mock-user" }),
  fetchFileContent: () => null,
};

// ─── Capture helper ─────────────────────────────────────────────────

async function capture<T>(method: string, args: unknown[], fn: () => T | Promise<T>): Promise<T> {
  let result: T;
  let error: string | undefined;
  try {
    result = await fn();
    return result;
  } catch (e) {
    error = String(e);
    throw e;
  } finally {
    // Only capture when mock mode is active
    if (state.active) {
      state.calls.push({
        id: state.nextId++,
        timestamp: Date.now(),
        method,
        args: serializeArgs(args),
        result: error
          ? { __mockError: error }
          : sanitizeForJson(result!),
      });
    }
  }
}

/** Make args JSON-safe (strip functions, cycles) */
function serializeArgs(args: unknown[]): unknown[] {
  return args.map((a) => sanitizeForJson(a));
}

/** Deep-clone with cycle protection and function stripping */
function sanitizeForJson(val: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(val, (_k, v) => typeof v === "function" ? "[Function]" : v));
  } catch {
    return String(val);
  }
}

// ─── Public state API ──────────────────────────────────────────────

export function getOutboundCalls(): OutboundCall[] {
  return [...state.calls];
}

export function clearOutboundCalls(): void {
  state.calls = [];
  state.nextId = 1;
}

export function setMockOverride(method: string, result: unknown): void {
  state.overrides.set(method, result);
}

export function clearMockOverride(method: string): void {
  state.overrides.delete(method);
}

export function clearAllOverrides(): void {
  state.overrides.clear();
}

export function getMockOverrides(): Record<string, unknown> {
  return Object.fromEntries(state.overrides);
}

export function setMockActive(active: boolean): void {
  state.active = active;
}

export function isMockActive(): boolean {
  return state.active;
}

// ─── Mock client factory ────────────────────────────────────────────

/** Look up the return value for a method (override → default → undefined) */
function resolveReturn(method: string): unknown {
  if (state.overrides.has(method)) {
    return state.overrides.get(method);
  }
  const factory = defaults[method];
  return factory ? factory() : undefined;
}

export function createMockGitHubClient(): GitHubClient {
  const make = <T>(method: string) =>
    (...args: unknown[]): Promise<T> =>
      capture(method, args, () => Promise.resolve(resolveReturn(method) as T));

  return {
    getPullRequest: make<PullRequest>("getPullRequest"),
    getPullRequestFiles: make<PullRequestFile[]>("getPullRequestFiles"),
    getPullRequestDiff: make<string>("getPullRequestDiff"),
    getPrComments: make<IssueComment[]>("getPrComments"),
    createIssueComment: make<IssueComment>("createIssueComment"),
    updateIssueComment: make<IssueComment>("updateIssueComment"),
    checkCollaborator: make<boolean>("checkCollaborator"),
    getRateLimit: make<RateLimit>("getRateLimit"),
    getWorkflowRun: make<WorkflowRun>("getWorkflowRun"),
    approveWorkflowRun: make<void>("approveWorkflowRun"),
    addLabels: make<void>("addLabels"),
    removeLabels: make<void>("removeLabels"),
    createCheckRun: make<void>("createCheckRun"),
    searchPulls: make<PullRequestSummary[]>("searchPulls"),
    createGist: make<{ id: string; html_url: string }>("createGist"),
    getBotComments: make<IssueComment[]>("getBotComments"),
    findBotComment: make<IssueComment | null>("findBotComment"),
    findWorkflowRunsByHeadSha: make<WorkflowRun[]>("findWorkflowRunsByHeadSha"),
    syncLabels: make<void>("syncLabels"),
    findPrFromHeadRef: make<PullRequestSummary>("findPrFromHeadRef"),
    getArtifactsFromWorkflow: make<Artifact[]>("getArtifactsFromWorkflow"),
    listPullsPage: make<PullRequestListItem[]>("listPullsPage"),
    listAllPulls: make<PullRequestListItem[]>("listAllPulls"),
    getGitTree: make<GitTreeEntry[]>("getGitTree"),
    getUser: make<{ login: string; id: number }>("getUser"),
    getUserByLogin: make<{ id: number; login: string }>("getUserByLogin"),
    searchIssues: make<SearchIssueResult>("searchIssues"),

    fetchFileContent: make<Record<string, string> | null>("fetchFileContent"),
    createReview: make<CreateReviewResult>("createReview"),
    listReviewComments: make<ReviewComment[]>("listReviewComments"),
    createReviewCommentReply: make<ReviewComment>("createReviewCommentReply"),
  };
}
