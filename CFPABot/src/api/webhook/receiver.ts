// src/api/webhook/receiver.ts
// HMAC-SHA256 verification + event deserialization + security guards.
// The public Event type from types.ts is replaced by a local WebhookEvent
// used only within the webhook path. Flow-originated code never sees the
// raw webhook payload.

import crypto from "node:crypto";
import { Webhooks } from "@octokit/webhooks";
import { isPrComment } from "./dto.js";
import { REPO } from "@/config.js";


export interface WebhookEvent {
  type: string;
  source: string;
  payload: unknown;
  raw?: unknown;
  replyTo?: {
    type: "github-comment" | "websocket";
    address: string;
  };
}

/**
 * Verify HMAC-SHA256 webhook signature from GitHub.
 * Delegates to @octokit/webhooks for constant-time comparison.
 * 每次调用新建 Webhooks 实例(开销可忽略,避免首次 secret 缓存导致 secret 轮换后失效)。
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  try {
    const webhooks = new Webhooks({ secret });
    // This route reads x-hub-signature-256 only. Require the explicit
    // sha256 prefix so @octokit/webhooks verifies HMAC-SHA256; a bare hex
    // string would make it fall back to HMAC-SHA1 (legacy header).
    if (!signatureHeader.startsWith("sha256=")) return false;
    return await webhooks.verify(rawBody, signatureHeader);
  } catch {
    return false;
  }
}

/**
 * Deserialize GitHub webhook payload into our WebhookEvent type.
 * Returns null for events that should be silently dropped.
 */
export function deserializeEvent(
  eventName: string,
  action: string | undefined,
  body: unknown,
): WebhookEvent | null {
  // Build a stable event-type string matching our dispatch
  const type = action ? `${eventName}.${action}` : eventName;

  // Drop events we don't care about
  if (eventName === "pull_request" && action === "review_requested") return null;
  if (eventName === "pull_request" && action === "review_request_removed") return null;
  if (eventName === "pull_request" && action === "assigned") return null;
  if (eventName === "pull_request" && action === "unassigned") return null;
  if (eventName === "pull_request" && action === "auto_merge_enabled") return null;
  if (eventName === "pull_request" && action === "auto_merge_disabled") return null;
  if (eventName === "pull_request" && action === "converted_to_draft") return null;
  if (eventName === "pull_request" && action === "ready_for_review") return null;
  if (eventName === "pull_request" && action === "locked") return null;
  if (eventName === "pull_request" && action === "unlocked") return null;
  if (eventName === "pull_request" && action === "enqueued") return null;
  if (eventName === "pull_request" && action === "dequeued") return null;
  if (eventName === "pull_request" && action === "milestoned") return null;
  if (eventName === "pull_request" && action === "demilestoned") return null;
  if (eventName === "pull_request_review") return null;
  if (eventName === "pull_request_review_thread") return null;
  if (eventName === "pull_request_review_comment") return null;
  if (eventName === "status") return null;
  if (eventName === "check_suite") return null;
  if (eventName === "check_run") return null;
  if (eventName === "create") return null;
  if (eventName === "delete") return null;
  if (eventName === "fork") return null;
  if (eventName === "star") return null;
  if (eventName === "watch") return null;
  if (eventName === "member") return null;
  if (eventName === "installation") return null;
  if (eventName === "installation_repositories") return null;
  if (eventName === "marketplace_purchase") return null;
  if (eventName === "org_block") return null;
  if (eventName === "organization") return null;
  if (eventName === "membership") return null;
  if (eventName === "team") return null;
  if (eventName === "team_add") return null;
  if (eventName === "repository") return null;
  if (eventName === "repository_vulnerability_alert") return null;
  if (eventName === "discussion") return null;
  if (eventName === "discussion_comment") return null;
  if (eventName === "label") return null;
  if (eventName === "milestone") return null;
  if (eventName === "project_card") return null;
  if (eventName === "project_column") return null;
  if (eventName === "project") return null;
  if (eventName === "meta") return null;
  if (eventName === "github_app_authorization") return null;

  return {
    type,
    source: "github",
    payload: body,
  };
}

// Minimal webhook payload shape for repository/id checks.
interface MinimalWebhookPayload {
  repository?: { owner?: { login?: string }; name?: string };
  installation?: { id?: number };
}

/**
 * Validate that the event targets our repository.
 * installation.created is exempt — accept all installation events.
 */
export function validateRepository(payload: unknown, eventType: string): boolean {
  // Allow all installation events (created/deleted)
  if (eventType.startsWith("installation")) return true;

  const p = payload as MinimalWebhookPayload;
  return (
    p?.repository?.owner?.login === REPO.OWNER &&
    p?.repository?.name === REPO.NAME
  );
}

/**
 * Detect if comment body contains the refresh checkbox pattern.
 */
const REFRESH_PATTERNS = ["- [x] 🔃", "- [x] 🔄"];

export function hasRefreshCheckbox(body: string): boolean {
  return REFRESH_PATTERNS.some((p) => body.includes(p));
}

/**
 * Authenticate manual trigger endpoint via query parameter.
 */
export function authenticateManualEndpoint(queryPassword: string, secret: string): boolean {
  if (!queryPassword || !secret) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(queryPassword), Buffer.from(secret));
  } catch {
    return false;
  }
}

