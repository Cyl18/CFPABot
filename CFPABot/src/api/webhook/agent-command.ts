// src/api/webhook/agent-command.ts
// Handle /agent and /agent-review commands issued via GitHub PR comments.
// Extracted from route.ts so the route handler stays a thin HTTP adapter:
// route.ts does body parsing + DTO conversion, then delegates command
// routing here. All admin checks, dedup key construction, and session
// creation live in this module — the route layer never sees raw payload
// fields beyond what's needed to detect a command.

import type { GitHubClient } from "@/client/github/index.js";
import type { Logger } from "@/logger.js";
import type { EntryConfig } from "@/config.js";
import type { FlowRegistry } from "@/engine/registry.js";
import { isPrComment, isAgentReviewCommand } from "./dto.js";
import { requireAdminCommenter } from "./command-auth.js";

/** Injected by bootstrap — creates + starts sessions for /agent* commands. */
export interface AgentCommandSessionCreator {
  createSession(params: {
    login: string;
    githubId: number;
    prNumber: number;
    baseSha: string;
    headSha: string;
    objective: string;
    /** Persistent dedup key `${deliveryId}:${commentId}` — SessionService enforces exactly-once. */
    dedupKey: string;
  }): Promise<{ sessionId: string; created: boolean }>;
  startSession(sessionId: string): Promise<void>;
}

export interface AgentCommandDeps {
  githubClient: GitHubClient;
  logger: Logger;
  config: EntryConfig;
  registry: FlowRegistry;
  sessionCreator?: AgentCommandSessionCreator;
  /** Raw delivery id from x-github-delivery header (may be empty — manual triggers). */
  deliveryId?: string;
}

/**
 * Try to handle an /agent-review command on a PR comment.
 * Returns true if the comment was an /agent-review command (and therefore
 * dispatch should be skipped), false otherwise.
 *
 * All error paths log and return true once the command has been recognized —
 * we never fall through to dispatch for a command-shaped comment.
 */
export async function handleAgentReviewCommand(
  body: unknown,
  eventType: string,
  deps: AgentCommandDeps,
): Promise<boolean> {
  // Only react to newly-created PR comments.
  if (eventType !== "issue_comment.created") return false;
  if (!isPrComment(body)) return false;

  const payload = body as Record<string, unknown>;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const commentBody = (comment?.body as string | undefined) ?? "";
  if (!isAgentReviewCommand(commentBody)) return false;

  // ── /agent-review: create Session ────────────────────────────
  deps.logger.info({}, "/agent-review command received");
  const userTail = commentBody.trim().replace(/^\/agent-review\b/, "").trim();
  // Route /agent-review through the translation-review skill. The skill
  // body is loaded by CfpabotResourceLoader.getSkills() from
  // skills/translation-review/SKILL.md; the /skill: prefix in the objective
  // tells resolvePromptText to expand it inline for the first turn.
  const objective = `/skill:translation-review${userTail ? ` — ${userTail}` : ""}`;

  const sender = payload.sender as Record<string, unknown> | undefined;
  const commenterLogin = (sender?.login ?? "") as string;
  const commenterId = (sender?.id ?? 0) as number;
  if (!commenterLogin) {
    deps.logger.warn({}, "/agent-review command from unknown user, ignoring");
    return true;
  }

  const senderType = (sender?.type ?? "") as string;
  if (senderType === "Bot") {
    deps.logger.info({ login: commenterLogin }, "/agent-review command from bot, ignoring");
    return true;
  }

  const issue = payload.issue as Record<string, unknown> | undefined;
  const prNumber = (issue?.number ?? payload.number) as number;
  const commentId = ((comment as Record<string, unknown> | undefined)?.id ?? 0) as number;

  // Admin check
  if (!(await requireAdminCommenter(deps.githubClient, deps.logger, prNumber, commenterLogin))) {
    return true;
  }

  let baseSha = "";
  let headSha = "";
  try {
    const pr = await deps.githubClient.getPullRequest(prNumber);
    baseSha = pr.base?.sha ?? "";
    headSha = pr.head?.sha ?? "";
  } catch (err) {
    deps.logger.error(
      { err: String(err), prNumber },
      "Failed to fetch PR data for /agent-review",
    );
    return true;
  }

  if (!deps.sessionCreator) {
    deps.logger.error({ prNumber }, "Session creator not configured; cannot handle /agent command");
    return true;
  }

  const dedupKey = `${deps.deliveryId ?? ""}:${commentId}`;

  try {
    const { sessionId, created } = await deps.sessionCreator.createSession({
      login: commenterLogin,
      githubId: commenterId,
      prNumber,
      baseSha,
      headSha,
      objective,
      dedupKey,
    });
    deps.logger.info(
      { sessionId, prNumber, login: commenterLogin, created },
      "/agent-review session created",
    );

    if (created) {
      deps.sessionCreator.startSession(sessionId).catch((startErr) => {
        deps.logger.error(
          { err: String(startErr), sessionId },
          "Failed to start /agent-review session ReAct loop",
        );
      });
    }
  } catch (err) {
    deps.logger.error({ err: String(err), prNumber }, "Failed to create /agent-review session");
  }

  return true;
}

/**
 * Try to handle an /agent command (free-form natural-language objective) on a
 * PR comment. Creates a general-purpose agent session — no review skill —
 * the agent may call any registered Flow to accomplish the user's goal.
 * Returns true when the comment was an /agent command, false otherwise.
 */
export async function handleAgentCommand(
  body: unknown,
  eventType: string,
  deps: AgentCommandDeps,
): Promise<boolean> {
  // Only react to newly-created PR comments.
  if (eventType !== "issue_comment.created") return false;
  if (!isPrComment(body)) return false;

  const payload = body as Record<string, unknown>;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const commentBody = (comment?.body as string | undefined) ?? "";
  const firstLine = commentBody.trim().split("\n")[0]?.trim() ?? "";
  if (!/^\/agent(?:\s|$)/.test(firstLine)) return false;

  // /agent-review is handled by handleAgentReviewCommand — never reach here.
  const objectiveTail = firstLine.replace(/^\/agent(?:\s|$)/, "").trim();
  const objective =
    objectiveTail || "请查看当前 PR，完成用户要求的操作（默认：理解并汇报 PR 内容）。";

  const sender = payload.sender as Record<string, unknown> | undefined;
  const commenterLogin = (sender?.login ?? "") as string;
  const commenterId = (sender?.id ?? 0) as number;
  if (!commenterLogin) {
    deps.logger.warn({}, "/agent command from unknown user, ignoring");
    return true;
  }

  const senderType = (sender?.type ?? "") as string;
  if (senderType === "Bot") {
    deps.logger.info({ login: commenterLogin }, "/agent command from bot, ignoring");
    return true;
  }

  const issue = payload.issue as Record<string, unknown> | undefined;
  const prNumber = (issue?.number ?? payload.number) as number;
  const commentId = ((comment as Record<string, unknown> | undefined)?.id ?? 0) as number;

  // Admin check
  if (!(await requireAdminCommenter(deps.githubClient, deps.logger, prNumber, commenterLogin))) {
    return true;
  }

  let baseSha = "";
  let headSha = "";
  try {
    const pr = await deps.githubClient.getPullRequest(prNumber);
    baseSha = pr.base?.sha ?? "";
    headSha = pr.head?.sha ?? "";
  } catch (err) {
    deps.logger.error(
      { err: String(err), prNumber },
      "Failed to fetch PR data for /agent",
    );
    return true;
  }

  if (!deps.sessionCreator) {
    deps.logger.error({ prNumber }, "Session creator not configured; cannot handle /agent command");
    return true;
  }

  const dedupKey = `${deps.deliveryId ?? ""}:${commentId}`;

  try {
    const { sessionId, created } = await deps.sessionCreator.createSession({
      login: commenterLogin,
      githubId: commenterId,
      prNumber,
      baseSha,
      headSha,
      objective,
      dedupKey,
    });
    deps.logger.info(
      { sessionId, prNumber, login: commenterLogin, created },
      "/agent session created",
    );

    if (created) {
      deps.sessionCreator.startSession(sessionId).catch((startErr) => {
        deps.logger.error(
          { err: String(startErr), sessionId },
          "Failed to start /agent session ReAct loop",
        );
      });
    }
  } catch (err) {
    deps.logger.error({ err: String(err), prNumber }, "Failed to create /agent session");
  }

  return true;
}
