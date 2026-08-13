// src/client/github/mappers.ts
// Octokit response -> narrow domain type mappers.

import type {
  PullRequest,
  PullRequestFile,
  IssueComment,
  WorkflowRun,
  PullRequestSummary,
  PullRequestListItem,
  SearchIssueItem,
} from "./types.js";

export function mapPullRequest(d: {
  number: number;
  title?: string;
  html_url: string;
  state: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  head: { sha: string; ref: string; repo?: { owner?: { login: string } | null } | null };
  base: { ref: string; sha?: string };
  draft?: boolean;
  user?: { login: string; id: number; email?: string | null } | null;
}): PullRequest {
  return {
    number: d.number,
    title: d.title ?? "",
    html_url: d.html_url,
    state: d.state as "open" | "closed",
    created_at: d.created_at ?? "",
    updated_at: d.updated_at ?? "",
    merged_at: d.merged_at ?? null,
    head: {
      sha: d.head.sha,
      ref: d.head.ref,
      repo: { owner: d.head.repo?.owner ?? null },
    },
    base: { ref: d.base.ref, sha: d.base.sha },
    user: d.user
      ? { login: d.user.login, id: d.user.id, ...(d.user.email ? { email: d.user.email } : {}) }
      : null,
    draft: d.draft ?? false,
  };
}

export function mapPullRequestFile(d: {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}): PullRequestFile {
  return {
    filename: d.filename,
    status: d.status,
    additions: d.additions,
    deletions: d.deletions,
    changes: d.changes,
    ...(d.patch !== undefined ? { patch: d.patch } : {}),
    ...(d.previous_filename !== undefined ? { previous_filename: d.previous_filename } : {}),
  };
}

export function mapIssueComment(d: {
  id: number;
  body?: string | null;
  user?: { login: string; id: number } | null;
}): IssueComment {
  return {
    id: d.id,
    body: d.body ?? "",
    user: d.user ? { login: d.user.login, id: d.user.id } : null,
  };
}

export function mapWorkflowRun(d: {
  id: number;
  name?: string;
  status: string | null;
  conclusion: string | null;
  check_suite_id?: number;
  artifacts_url?: string;
  html_url: string;
}): WorkflowRun {
  return {
    id: d.id,
    name: d.name ?? "",
    status: d.status ?? "",
    conclusion: d.conclusion,
    check_suite_id: d.check_suite_id ?? 0,
    artifacts_url: d.artifacts_url ?? "",
    html_url: d.html_url,
  };
}

export function mapPullRequestSummary(d: {
  number: number;
  html_url: string;
  state: string;
  user?: { login: string; id: number } | null;
}): PullRequestSummary {
  return {
    number: d.number,
    html_url: d.html_url,
    state: d.state as "open" | "closed",
    user: d.user ? { login: d.user.login, id: d.user.id } : null,
  };
}

/** Map a PR from the pulls list endpoint (richer than search result). */
export function mapPullRequestListItem(d: {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at?: string | null;
  user?: { login: string; id: number } | null;
  labels?: Array<{ name: string; color?: string }>;
  created_at: string;
  updated_at: string;
  head?: { sha: string };
  draft?: boolean;
}): PullRequestListItem {
  return {
    number: d.number,
    title: d.title,
    html_url: d.html_url,
    state: d.state as "open" | "closed",
    merged_at: d.merged_at ?? null,
    user: d.user ? { login: d.user.login, id: d.user.id } : null,
    labels: (d.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    created_at: d.created_at,
    updated_at: d.updated_at,
    ...(d.head ? { head: { sha: d.head.sha } } : {}),
    draft: d.draft ?? false,
  };
}

/** Map a search/issue result item. */
export function mapSearchIssueItem(d: {
  number: number;
  title: string;
  html_url: string;
  state: string;
  user?: { login: string } | null;
  labels?: Array<{ name: string; color?: string }>;
  created_at: string;
  pull_request?: { merged_at?: string } | null;
  closed_at?: string | null;
}): SearchIssueItem {
  return {
    number: d.number,
    title: d.title,
    html_url: d.html_url,
    state: d.state,
    user: d.user ? { login: d.user.login } : null,
    labels: (d.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    created_at: d.created_at,
    pull_request: d.pull_request ? { merged_at: d.pull_request.merged_at } : null,
    closed_at: d.closed_at ?? null,
  };
}
