// src/api/webhook/route.ts
// Webhook receiver and manual trigger routes.
// Converts raw GitHub payload to stable WebhookDto, enriches missing fields,
// then dispatches to the programmatic flow router.  /agent commands create
// a persistent agent session via SessionService (not dispatch).

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
import type { AgentCommandSessionCreator } from "./agent-command.js";
import { handleAgentReviewCommand, handleAgentCommand } from "./agent-command.js";
import { handleDirectCommand } from "./direct-commands.js";
import { MAX_BODY_SIZE } from "@/api/frontend/helpers.js";
// ---- Webhook dedup (TTL cache for x-github-delivery) ----
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
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

// ---- Durable /agent session dedup — handled by SessionService/FileStore ----
// No module-level Set.  SessionService.createSession with dedupKey provides
// exactly-once per (deliveryId, commentId) tuple, surviving redelivery.

// Dependencies injected by the main app before routes are used
let _githubClient: GitHubClient;
let _logger: Logger;
let _config: EntryConfig;
let _registry: FlowRegistry;
let _shuttingDown = false;
let _webhookSessionCreator: AgentCommandSessionCreator | null = null;

export function initWebhookRoutes(
  githubClient: GitHubClient,
  logger: Logger,
  config: EntryConfig,
  registry: FlowRegistry,
  sessionCreator?: AgentCommandSessionCreator,
): void {
  _githubClient = githubClient;
  _logger = logger;
  _config = config;
  _registry = registry;
  if (sessionCreator) _webhookSessionCreator = sessionCreator;
}

export function setWebhookShutdown(state: boolean): void {
  _shuttingDown = state;
}

export const webhookRouter = new Hono();

// ─── In-flight webhook operations (graceful shutdown) ─────────────────
// Webhook handling is fire-and-forget from the HTTP layer's perspective
// (dispatch().catch). Track the ops so shutdown can wait for a started
// git push / comment before exiting — killing the process mid-push makes
// GitHub redeliver and re-execute side effects.
const pendingWebhookOps = new Set<Promise<unknown>>();

/**
 * Wait (bounded) for all started webhook operations to settle.
 * Resolves immediately when none are pending; never rejects.
 */
export function waitForWebhookOps(timeoutMs: number): Promise<void> {
  if (pendingWebhookOps.size === 0) return Promise.resolve();
  return Promise.race([
    Promise.allSettled([...pendingWebhookOps]).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// POST /api/webhook — GitHub webhook receiver
webhookRouter.post("/webhook", (c) => {
  if (_shuttingDown) return c.text("Service Unavailable", 503);
  // Track the whole handling pipeline so graceful shutdown can drain it.
  const op = handleWebhookBody(c);
  pendingWebhookOps.add(op);
  op.finally(() => pendingWebhookOps.delete(op)).catch(() => {});
  return op;
});

async function handleWebhookBody(c: Context): Promise<Response> {

  // Enforce body size limit BEFORE reading the body
  const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    _logger.warn({ contentLength }, "Webhook 请求体超过大小限制");
    return c.text("Request Entity Too Large", 413);
  }

  const signature = c.req.header("x-hub-signature-256") ?? "";
  const eventName = c.req.header("x-github-event") ?? "";
  const rawBody = await c.req.text();

  // chunked 编码或无 content-length 时可绕过头部检查 — 读取后按实际长度再校验一次
  if (rawBody.length > MAX_BODY_SIZE) {
    _logger.warn({ bodyLength: rawBody.length }, "Webhook 请求体实际大小超过限制");
    return c.text("Request Entity Too Large", 413);
  }

  // HMAC verification
  const valid = await verifyWebhookSignature(rawBody, signature, _config.webhookSecret);
  if (!valid) {
    _logger.warn({}, "Webhook HMAC 验证失败");
    return c.text("Unauthorized", 401);
  }

  // Check for duplicate delivery (after HMAC, before any processing)
  const deliveryId = c.req.header("x-github-delivery");
  if (deliveryId && isDuplicate(deliveryId)) {
    _logger.debug({ deliveryId }, "重复 webhook 事件，跳过");
    return c.text("OK", 200);
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    _logger.warn({}, "Webhook body 不是合法 JSON");
    return c.text("Bad Request", 400);
  }
  const action = (body as Record<string, unknown> | undefined)?.action as string | undefined;

  // Deserialize event (after body is available)
  const event = deserializeEvent(eventName, action, body);
  if (!event) {
    return c.text("Accepted", 202);
  }

  if (!validateRepository(body, event.type)) {
    _logger.info({ type: event.type }, "非目标仓库事件，忽略");
    return c.text("Accepted", 202);
  }

  // ---- Convert raw event to stable DTO before any business logic ----
  const dto = eventToDto(event.type, body, deliveryId ?? undefined);

// ---- Comment command handling ----
// Direct commands (/add-co-author, /update-en, /sort-keys, /add-mapping)
// execute their Flow directly; /agent-review and /agent create sessions.
// agent-command.ts / direct-commands.ts do the admin checks + PR data
// fetch + session creation. All three return true once the comment is a
// recognized command — dispatch is then skipped.
const commandDeps = {
  githubClient: _githubClient,
  logger: _logger,
  config: _config,
  registry: _registry,
  sessionCreator: _webhookSessionCreator!,
  deliveryId: deliveryId ?? undefined,
};
const commandHandled =
  (await handleDirectCommand(body, event.type, commandDeps)) ||
  (await handleAgentReviewCommand(body, event.type, commandDeps)) ||
  (await handleAgentCommand(body, event.type, commandDeps));
if (commandHandled) {
  return c.text("Accepted", 202);
}

  // ---- Enrich DTO with missing fields before dispatch ----
  // For issue_comment.edited (force refresh), acquire head SHA from GitHub API
  // so dispatch never receives an empty SHA.
  if (dto && dto.type === "issue_comment.edited" && dto.isPrComment && !dto.headSha) {
    try {
      const pr = await _githubClient.getPullRequest(dto.prNumber);
      dto.headSha = pr.head.sha;
    } catch (err) {
      _logger.warn({ err: String(err), prNumber: dto.prNumber }, "Failed to fetch head SHA for issue_comment.edited");
    }
  }

  // ---- Normal dispatch with stable DTO ----
  if (dto) {
    const deps = {
      github: _githubClient,
      logger: _logger,
      config: _config,
    };

    dispatch(dto, deps, _registry).catch((err: Error) => {
      _logger.error({ err: String(err), type: dto!.type }, "dispatch 异步异常");
    });
  }

  return c.text("Accepted", 202);
}

// GET /api/webhook — manual trigger endpoint
webhookRouter.get("/webhook", (c) => {
  const password = c.req.query("password") ?? "";
  if (!authenticateManualEndpoint(password, _config.webhookSecret)) {
    return c.text("Forbidden", 403);
  }

  return c.json({
    message: "CFPAAgent Webhook 手动触发端点是可用的。",
    endpoints: {
      "/api/webhook": { description: "接收 GitHub Webhook", methods: ["POST"] },
    },
    triggerInstructions: "请使用您自己的 GitHub Webhook 配置自动触发。",
    patStatus: _config.githubAppId ? `GitHub App ID ${_config.githubAppId} 已配置` : "未配置 GitHub App",
  });
});
