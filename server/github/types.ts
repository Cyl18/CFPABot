import type { PrFile } from "../../shared/api.ts";

export interface GhPull {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  author: string;
  authorId: number;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  headRepoOwner: string | null;
  headRepoName: string | null;
}

export interface GhFile extends PrFile {
  patch?: string;
}

export interface GhComment {
  id: number;
  author: string;
  isBot: boolean;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface GhReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  inReplyTo?: number;
  createdAt: string;
  htmlUrl: string;
}

export interface GhRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  event: string;
  headSha: string;
  headBranch: string;
  headOwner: string | null;
  htmlUrl: string;
  createdAt: string;
  pullNumbers: number[];
}

export interface GhArtifact {
  id: number;
  name: string;
  expired: boolean;
  url: string;
}

export interface GitHubClient {
  mode: "app" | "pat" | "anonymous";
  getPull(n: number): Promise<GhPull>;
  listPulls(state: "open" | "closed", opts?: { maxPages?: number }): Promise<GhPull[]>;
  findPullByHead(ownerColonBranch: string): Promise<GhPull | null>;
  listPullFiles(n: number): Promise<GhFile[]>;
  getFile(path: string, ref: string): Promise<string | null>;
  listComments(n: number): Promise<GhComment[]>;
  createComment(n: number, body: string): Promise<GhComment>;
  updateComment(id: number, body: string): Promise<void>;
  listReviewComments(n: number): Promise<GhReviewComment[]>;
  createReview(
    n: number,
    input: {
      commitId: string;
      body: string;
      event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
      comments: { path: string; line: number; side: "RIGHT"; body: string }[];
    },
  ): Promise<{ id: number; htmlUrl: string }>;
  addLabels(n: number, labels: string[]): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
  createCheckRun(input: {
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
  }): Promise<void>;
  listPackerRuns(headSha: string): Promise<GhRun[]>;
  listArtifacts(runId: number): Promise<GhArtifact[]>;
  approveRun(runId: number): Promise<void>;
  isCollaborator(login: string): Promise<boolean>;
  getUser(login: string): Promise<{ login: string; id: number } | null>;
  createGist(description: string, fileName: string, content: string): Promise<string>;
  rateLimit(): Promise<{ remaining: number; limit: number; resetAt: string }>;
  gitToken(): Promise<string | null>;
}
