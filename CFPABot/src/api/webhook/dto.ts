// src/api/webhook/dto.ts
// Stable webhook DTOs — typed, minimal fields extracted from raw GitHub payload.
// No raw payload fields leak beyond this module.
// Each DTO carries only what dispatch and Flow execution need.

import { REPO } from "@/config.js";

// ─── PR Events ───────────────────────────────────────────────────────

export interface PullRequestChangedDto {
  type:
    | "pull_request.opened"
    | "pull_request.synchronize"
    | "pull_request.edited"
    | "pull_request.labeled"
    | "pull_request.unlabeled";
  deliveryId?: string;
  prNumber: number;
  actorLogin: string;
  baseSha: string;
  headSha: string;
  commentBody?: string;
}

export interface PullRequestClosedDto {
  type: "pull_request.closed";
  deliveryId?: string;
  prNumber: number;
  actorLogin: string;
  merged: boolean;
}

// ─── Issue Comment Events ───────────────────────────────────────────

export interface IssueCommentCreatedDto {
  type: "issue_comment.created";
  deliveryId?: string;
  prNumber: number;
  commentId: number;
  actorLogin: string;
  commentBody: string;
  isPrComment: boolean;
}

export interface IssueCommentEditedDto {
  type: "issue_comment.edited";
  deliveryId?: string;
  prNumber: number;
  commentId: number;
  actorLogin: string;
  commentBody: string;
  isPrComment: boolean;
  headSha: string;
}

// ─── Workflow Run Events ────────────────────────────────────────────

export interface WorkflowRunChangedDto {
  type: "workflow_run.completed";
  deliveryId?: string;
  prNumber: number;
  workflowName: string;
  workflowRunId: number;
  headSha: string;
}

// ─── Push Events ────────────────────────────────────────────────────

export interface PushDto {
  type: "push";
  deliveryId?: string;
  ref: string;
  headSha: string;
  actorLogin: string;
}

// ─── Union ──────────────────────────────────────────────────────────

export type WebhookDto =
  | PullRequestChangedDto
  | PullRequestClosedDto
  | IssueCommentCreatedDto
  | IssueCommentEditedDto
  | WorkflowRunChangedDto
  | PushDto;

// ─── Helpers ────────────────────────────────────────────────────────

export function isPrComment(body: unknown): boolean {
  const obj = body as Record<string, unknown> | undefined;
  if (!obj) return false;
  const issue = obj.issue as Record<string, unknown> | undefined;
  return issue?.pull_request !== undefined;
}

/**
 * Detect if comment body contains an /agent-review command as the first non-empty line.
 */
export function isAgentReviewCommand(body: string): boolean {
  const firstLine = body.trim().split("\n")[0]?.trim() ?? "";
  return /^\/agent-review\b/.test(firstLine);
}

/**
 * Extract the stable DTO from a raw webhook event payload.
 * Returns null for events that cannot be mapped to a known DTO.
 */
export function eventToDto(
  type: string,
  payload: unknown,
  deliveryId?: string,
): WebhookDto | null {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) return null;

  const issue = p.issue as Record<string, unknown> | undefined;
  const pullRequest = p.pull_request as Record<string, unknown> | undefined;
  const comment = p.comment as Record<string, unknown> | undefined;
  const sender = p.sender as Record<string, unknown> | undefined;
  const workflowRun = p.workflow_run as Record<string, unknown> | undefined;

  const prNumber = (pullRequest?.number ?? issue?.number ?? p.number ?? 0) as number;
  const actorLogin = (sender?.login ?? "") as string;
  const pushRef = (p.ref ?? "") as string;

  switch (type) {
    case "pull_request.opened":
    case "pull_request.synchronize":
    case "pull_request.edited":
    case "pull_request.labeled":
    case "pull_request.unlabeled": {
      return {
        type,
        deliveryId,
        prNumber,
        actorLogin,
        baseSha: (pullRequest?.base as Record<string, unknown> | undefined)?.sha as string ?? "",
        headSha: (pullRequest?.head as Record<string, unknown> | undefined)?.sha as string ?? "",
      };
    }

    case "pull_request.closed": {
      return {
        type: "pull_request.closed",
        deliveryId,
        prNumber,
        actorLogin,
        merged: !!pullRequest?.merged,
      };
    }

    case "issue_comment.created": {
      return {
        type: "issue_comment.created",
        deliveryId,
        prNumber: (issue?.number ?? 0) as number,
        commentId: (comment?.id ?? 0) as number,
        actorLogin,
        commentBody: (comment?.body ?? "") as string,
        isPrComment: isPrComment(payload),
      };
    }

    case "issue_comment.edited": {
      return {
        type: "issue_comment.edited",
        deliveryId,
        prNumber: (issue?.number ?? 0) as number,
        commentId: (comment?.id ?? 0) as number,
        actorLogin,
        commentBody: (comment?.body ?? "") as string,
        isPrComment: isPrComment(payload),
        headSha: "",  // enriched by route layer before dispatch
      };
    }

    case "workflow_run.completed": {
      return {
        type: "workflow_run.completed",
        deliveryId,
        prNumber: (workflowRun?.pull_requests as Array<{ number: number }> | undefined)?.[0]?.number ?? 0,
        workflowName: (workflowRun?.name ?? "") as string,
        workflowRunId: (workflowRun?.id ?? 0) as number,
        headSha: (workflowRun?.head_sha ?? "") as string,
      };
    }

    case "push": {
      // Only refresh mod list for pushes to the default branch
      const defaultRef = `refs/heads/${REPO.DEFAULT_BRANCH}`;
      if (pushRef !== defaultRef) {
        return null;
      }
      return {
        type: "push",
        deliveryId,
        ref: pushRef,
        headSha: (p.after ?? "") as string,
        actorLogin: ((p.sender as Record<string, unknown> | undefined)?.login ?? "") as string,
      };
    }

    default:
      return null;
  }
}
