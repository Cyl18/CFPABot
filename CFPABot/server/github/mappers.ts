import type { PrFile } from "../../shared/api.ts";
import type { GhComment, GhFile, GhPull, GhReviewComment, GhRun } from "./types.ts";

export interface RawPull {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  merged?: boolean | null;
  merged_at?: string | null;
  draft?: boolean | null;
  user?: { login: string; id: number } | null;
  labels: (string | { name: string })[];
  created_at: string;
  updated_at: string;
  html_url: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; repo?: { name: string; owner?: { login: string } | null } | null };
  maintainer_can_modify?: boolean | null;
}

export interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string | null;
  patch?: string | null;
}

export interface RawComment {
  id: number;
  user?: { login: string; type?: string } | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface RawReviewComment {
  id: number;
  user?: { login: string } | null;
  body?: string | null;
  path: string;
  line?: number | null;
  in_reply_to_id?: number | null;
  created_at: string;
  html_url: string;
}

export interface RawRun {
  id: number;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event: string;
  head_sha: string;
  head_branch?: string | null;
  head_repository?: { owner?: { login: string } | null } | null;
  html_url: string;
  created_at: string;
  pull_requests?: { number: number }[] | null;
}

export function mapPull(d: RawPull): GhPull {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    state: d.state === "closed" ? "closed" : "open",
    merged: d.merged ?? d.merged_at != null,
    draft: d.draft === true,
    author: d.user?.login ?? "",
    authorId: d.user?.id ?? 0,
    labels: d.labels.map((l) => (typeof l === "string" ? l : l.name)),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    htmlUrl: d.html_url,
    baseRef: d.base.ref,
    baseSha: d.base.sha,
    headRef: d.head.ref,
    headSha: d.head.sha,
    headRepoOwner: d.head.repo?.owner?.login ?? null,
    headRepoName: d.head.repo?.name ?? null,
    maintainerCanModify: d.maintainer_can_modify ?? null,
  };
}

function fileStatus(status: string): PrFile["status"] {
  switch (status) {
    case "added":
    case "removed":
    case "modified":
    case "renamed":
    case "copied":
    case "changed":
    case "unchanged":
      return status;
    default:
      return "modified";
  }
}

export function mapFile(d: RawFile): GhFile {
  return {
    path: d.filename,
    status: fileStatus(d.status),
    additions: d.additions,
    deletions: d.deletions,
    ...(d.previous_filename ? { previousPath: d.previous_filename } : {}),
    ...(d.patch ? { patch: d.patch } : {}),
  };
}

export function mapComment(d: RawComment): GhComment {
  const login = d.user?.login ?? "";
  return {
    id: d.id,
    author: login,
    isBot: d.user?.type === "Bot" || login.endsWith("[bot]"),
    body: d.body ?? "",
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    htmlUrl: d.html_url,
  };
}

export function mapReviewComment(d: RawReviewComment): GhReviewComment {
  return {
    id: d.id,
    author: d.user?.login ?? "",
    body: d.body ?? "",
    path: d.path,
    line: d.line ?? null,
    ...(d.in_reply_to_id ? { inReplyTo: d.in_reply_to_id } : {}),
    createdAt: d.created_at,
    htmlUrl: d.html_url,
  };
}

export function mapRun(d: RawRun): GhRun {
  return {
    id: d.id,
    name: d.name ?? "",
    status: d.status ?? "",
    conclusion: d.conclusion ?? null,
    event: d.event,
    headSha: d.head_sha,
    headBranch: d.head_branch ?? "",
    headOwner: d.head_repository?.owner?.login ?? null,
    htmlUrl: d.html_url,
    createdAt: d.created_at,
    pullNumbers: (d.pull_requests ?? []).map((p) => p.number),
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function httpStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("status" in err)) return null;
  return typeof err.status === "number" ? err.status : null;
}
