// src/api/webhook/route.ts
// Webhook receiver and manual trigger routes.
// Converts raw GitHub payload to stable WebhookDto, enriches missing fields,
// then dispatches to the programmatic flow router.  /agent commands create
// a persistent agent session via SessionService (not dispatch).
//
// Ownership:
// - createWebhookRouter(deps) builds a router bound to its dependencies;
//   no module-level mutable globals.
// - The POST route validates the request, schedules the real work as a
//   background task, and returns 202 immediately. GitHub expects a fast
//   acknowledgement; direct commands (git clone/commit/push) can run for
//   minutes and must not hold the webhook HTTP response open.
// - The returned controller tracks every in-flight background task so
//   graceful shutdown can drain it before process exit.

import { Hono, type Context } from "hono";
import {
  verifyWebhookSignature,
  deserializeEvent,
  validateRepository,
  authenticateManualEndpoint,
} from "./receiver.js";
import { dispatch } from "./dispatch.js";
import { eventToDto } from "./dto.js";
import type { WebhookDto } from "./dto.js";
import type { Logger } from "@/logger.js";
import type { EntryConfig } from "@/config.js";
import type { GitHubClient } from "@/client/github/index.js";
import type { FlowRegistry } from "@/engine/registry.js";
import type { FileStore } from "@/types.js";
import type { AgentCommandSessionCreator } from "./agent-command.js";
import { handleAgentReviewCommand, handleAgentCommand } from "./agent-command.js";
import { handleDirectCommand } from "./direct-commands.js";
import { MAX_BODY_SIZE } from "@/api/frontend/helpers.js";

// ---- Webhook dedup (TTL cache for x-github-delivery) ----
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface WebhookRouteDeps {
  githubClient: GitHubClient;
  logger: Logger;
  config: EntryConfig;
  registry: FlowRegistry;
  fileStore: FileStore;
  sessionCreator?: AgentCommandSessionCreator;
}

export interface WebhookController {
  router: Hono;
  setShuttingDown(state: boolean): void;
  waitForWebhookOps(timeoutMs: number): Promise<void>;
}

/**
 * Build the webhook router and its lifecycle controller.
 * All mutable webhook state (shutdown flag, delivery dedup, in-flight ops)
 * lives inside this closure.
 */
export function createWebhookRouter(deps: WebhookRouteDeps): WebhookController {
  const { githubClient, logger, config, registry, fileStore, sessionCreator } = deps;

  let shuttingDown = false;
  const deliveredEvents = new Map<string, number>();
  let cleanupCounter = 0;

  function isDuplicate(deliveryId: string): boolean {
    const now = Date.now();
    if (deliveredEvents.has(deliveryId)) return true;
    deliveredEvents.set(deliveryId, now);
    cleanupCounter++;
    if (cleanupCounter >= 100) {
      cleanupCounter = 0;
      for (const [id, ts] of deliveredEvents) {
        if (now - ts > DEDUP_TTL_MS) deliveredEvents.delete(id);
      }
    }
    return false;
  }

  // ─── In-flight background webhook operations ─────────────────────────
  // Each accepted webhook schedules exactly one tracked task. The HTTP
  // response is returned before this task settles; shutdown waits for the
  // set below (bounded) so a started git push / comment is not killed
  // mid-flight.
  const pendingWebhookOps = new Set<Promise<unknown>>();

  function trackWebhookOp(op: Promise<unknown>): void {
    pendingWebhookOps.add(op);
    op.finally(() => pendingWebhookOps.delete(op)).catch(() => {});
  }

  function setShuttingDown(state: boolean): void {
    shuttingDown = state;
  }

  function waitForWebhookOps(timeoutMs: number): Promise<void> {
    if (pendingWebhookOps.size === 0) return Promise.resolve();
    return Promise.race([
      Promise.allSettled([...pendingWebhookOps]).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  // ─── Router ─────────────────────────────────────────────────────────

  const router = new Hono();

  // POST /api/webhook — GitHub webhook receiver
  router.post("/webhook", async (c) => {
    if (shuttingDown) return c.text("Service Unavailable", 503);

    const prepared = await validateWebhookRequest(c, config, logger, isDuplicate);
    if (prepared.kind === "response") return prepared.response;

    const task = runAcceptedWebhook(
      prepared.body,
      prepared.eventType,
      prepared.eventAction,
      prepared.dto,
      prepared.deliveryId,
      {
        githubClient,
        logger,
        config,
        registry,
        fileStore,
        sessionCreator,
      },
    );
    trackWebhookOp(task);
    return c.text("Accepted", 202);
  });

  // GET /api/webhook — manual trigger endpoint
  router.get("/webhook", (c) => {
    const password = c.req.query("password") ?? "";
    if (!authenticateManualEndpoint(password, config.webhookSecret)) {
      return c.text("Forbidden", 403);
    }

    return c.json({
      message: "CFPAAgent Webhook 手动触发端点是可用的。",
      endpoints: {
        "/api/webhook": { description: "接收 GitHub Webhook", methods: ["POST"] },
      },
      triggerInstructions: "请使用您自己的 GitHub Webhook 配置自动触发。",
      patStatus: config.githubAppId ? `GitHub App ID ${config.githubAppId} 已配置` : "未配置 GitHub App",
    });
  });

  return { router, setShuttingDown, waitForWebhookOps };
}

// ─── Request validation (synchronous from the webhook's perspective) ──

interface PreparedWebhook {
  kind: "task";
  body: unknown;
  eventType: string;
  eventAction: string;
  dto: WebhookDto | null;
  deliveryId?: string;
}

interface RejectedWebhook {
  kind: "response";
  response: Response;
}

async function validateWebhookRequest(
  c: Context,
  config: EntryConfig,
  logger: Logger,
  isDuplicate: (deliveryId: string) => boolean,
): Promise<PreparedWebhook | RejectedWebhook> {
  // Enforce body size limit BEFORE reading the body
  const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    logger.warn({ contentLength }, "Webhook 请求体超过大小限制");
    return { kind: "response", response: c.text("Request Entity Too Large", 413) };
  }

  const signature = c.req.header("x-hub-signature-256") ?? "";
  const eventType = c.req.header("x-github-event") ?? "";
  const rawBody = await c.req.text();

  // chunked 编码或无 content-length 时可绕过头部检查 — 读取后按实际长度再校验一次
  if (rawBody.length > MAX_BODY_SIZE) {
    logger.warn({ bodyLength: rawBody.length }, "Webhook 请求体实际大小超过限制");
    return { kind: "response", response: c.text("Request Entity Too Large", 413) };
  }

  // HMAC verification
  const valid = await verifyWebhookSignature(rawBody, signature, config.webhookSecret);
  if (!valid) {
    logger.warn({}, "Webhook HMAC 验证失败");
    return { kind: "response", response: c.text("Unauthorized", 401) };
  }

  // Check for duplicate delivery (after HMAC, before any processing)
  const deliveryId = c.req.header("x-github-delivery");
  if (deliveryId && isDuplicate(deliveryId)) {
    logger.debug({ deliveryId }, "重复 webhook 事件，跳过");
    return { kind: "response", response: c.text("OK", 200) };
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    logger.warn({}, "Webhook body 不是合法 JSON");
    return { kind: "response", response: c.text("Bad Request", 400) };
  }
  const action = (body as Record<string, unknown> | undefined)?.action as string | undefined;

  // Deserialize event (after body is available)
  const event = deserializeEvent(eventType, action, body);
  if (!event) {
    return { kind: "response", response: c.text("Accepted", 202) };
  }

  if (!validateRepository(body, event.type)) {
    logger.info({ type: event.type }, "非目标仓库事件，忽略");
    return { kind: "response", response: c.text("Accepted", 202) };
  }

  // Convert raw event to stable DTO before any business logic.
  const dto = eventToDto(event.type, body, deliveryId ?? undefined);

  return {
    kind: "task",
    body,
    eventType: event.type,
    eventAction: action ?? "",
    dto,
    deliveryId: deliveryId ?? undefined,
  };
}

// ─── Background task: commands + normal dispatch ───────────────────────

interface AcceptedWebhookDeps {
  githubClient: GitHubClient;
  logger: Logger;
  config: EntryConfig;
  registry: FlowRegistry;
  fileStore: FileStore;
  sessionCreator?: AgentCommandSessionCreator;
}

/**
 * Execute the accepted webhook in the background. The returned promise is
 * tracked by the controller; it never rejects (errors are logged), so the
 * shutdown drain uses Promise.allSettled and never turns a webhook failure
 * into an unhandled rejection.
 */
async function runAcceptedWebhook(
  body: unknown,
  eventType: string,
  eventAction: string,
  dto: WebhookDto | null,
  deliveryId: string | undefined,
  deps: AcceptedWebhookDeps,
): Promise<void> {
  const { githubClient, logger, config, registry, fileStore, sessionCreator } = deps;
  try {
    // ---- Comment command handling ----
    // Direct commands (/add-co-author, /update-en, /sort-keys, /add-mapping)
    // execute their Flow directly; /agent-review and /agent create sessions.
    // All three return true once the comment is a recognized command —
    // dispatch is then skipped.
    const agentCommandDeps = {
      githubClient,
      logger,
      config,
      registry,
      sessionCreator,
      deliveryId,
    };
    const commandHandled =
      (await handleDirectCommand(body, eventType, {
        githubClient,
        logger,
        config,
        registry,
        fileStore,
        deliveryId,
      })) ||
      (await handleAgentReviewCommand(body, eventType, agentCommandDeps)) ||
      (await handleAgentCommand(body, eventType, agentCommandDeps));
    if (commandHandled) return;

    // ---- Enrich DTO with missing fields before dispatch ----
    // For issue_comment.edited (force refresh), acquire head SHA from GitHub API
    // so dispatch never receives an empty SHA.
    if (dto && dto.type === "issue_comment.edited" && dto.isPrComment && !dto.headSha) {
      try {
        const pr = await githubClient.getPullRequest(dto.prNumber);
        dto.headSha = pr.head.sha;
      } catch (err) {
        logger.warn({ err: String(err), prNumber: dto.prNumber }, "Failed to fetch head SHA for issue_comment.edited");
      }
    }

    // ---- Normal dispatch with stable DTO ----
    if (dto) {
      await dispatch(dto, { github: githubClient, logger, config, store: fileStore }, registry);
    } else {
      logger.debug({ eventType, eventAction }, "Accepted webhook produced no DTO; nothing to dispatch");
    }
  } catch (err) {
    // Each command handler / dispatch already logs its own recoverable
    // failures. This is the final safety net for unexpected programming
    // errors — never let the tracked promise reject.
    logger.error(
      { err: String(err), eventType, eventAction, deliveryId },
      "Webhook background processing failed",
    );
  }
}
