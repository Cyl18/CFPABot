// src/api/frontend/dev/index.ts
// Developer panel API — mock webhook triggers, outbound call inspection, mock config.
// All routes require admin auth.

import { Hono } from "hono";
import { dispatch } from "@/api/webhook/dispatch.js";

import { eventToDto } from "@/api/webhook/dto.js";
import { getSharedRegistry } from "@/engine/registry-store.js";
import { createLogger } from "@/logger.js";
import type { Logger } from "@/logger.js";
import { REPO, AUTH } from "@/config.js";
import type { WebhookEvent } from "@/api/webhook/receiver.js";
import type { EntryConfig } from "@/config.js";
import { readCurseforgeMapping } from "@/client/cache.js";
import { executeFlow } from "@/engine/execute.js";
import { dev_unmapped_slugs } from "@/flows/mappings/unmapped_slugs.js";
import { buildUserFlowContext } from "@/api/flow-context.js";

import {
  createMockGitHubClient,
  getOutboundCalls,
  clearOutboundCalls,
  setMockOverride,
  clearMockOverride,
  clearAllOverrides,
  getMockOverrides,
  setMockActive,
  isMockActive,
  type OutboundCall,
} from "./mock-github.js";
import type { AppVariables } from "@/api/frontend/helpers.js";
import { requireAdmin } from "@/api/auth.js";

// ─── Logger (惰性创建) ──────────────────────────────────────────────
// 本模块在开发/生产环境都会被加载;若在模块顶层直接 createLogger(),
// 生产环境也会向 combined.log 打开第二个 pino 写入端,造成日志重复。
// 因此延迟到首次使用时才创建。

let _logger: Logger | null = null;
function devLogger(): Logger {
  if (!_logger) _logger = createLogger(getDevConfig());
  return _logger;
}

function getDevConfig(): EntryConfig {
  return {
    owner: REPO.OWNER,
    repoName: REPO.NAME,
    repoId: REPO.ID,
    repoUrl: REPO.BASE_URL,
    defaultBranch: REPO.DEFAULT_BRANCH,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "dev-mock-secret",
    personalAccessToken: process.env.GITHUB_OAUTH_TOKEN ?? "",
    githubAppId: Number(process.env.GITHUB_APP_ID ?? 0),
    githubAppPemPath: "config/cfpa-bot.pem",
    githubAppInstallationId: Number(process.env.GITHUB_APP_INSTALLATION_ID ?? 0),
    port: Number(process.env.PORT ?? 8080),
    environment: process.env.ASPNETCORE_ENVIRONMENT === "Development" ? "development" : "production",
    logLevel: (process.env.LOG_LEVEL as EntryConfig["logLevel"]) ?? "info",
    oauthClientId: process.env.OAUTH_CLIENT_ID ?? "",
    oauthTokenCookieName: AUTH.OAUTH_TOKEN_COOKIE_NAME,
    pemKey: "",
    reviewPublishEnabled: process.env.REVIEW_PUBLISH_ENABLED === "true",
  };
}

// ─── Event type catalogue (for the UI dropdown) ─────────────────────

const EVENT_TYPES = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.labeled",
  "pull_request.unlabeled",
  "pull_request.edited",
  "pull_request.closed",
  "issue_comment.created",
  "issue_comment.edited",
  "workflow_run.completed",
] as const;

// ───Router ──────────────────────────────────────────────────────────

export const devRouter = new Hono<{ Variables: AppVariables }>();

// Block entirely in non-Development environments
devRouter.use("*", async (c, next) => {
  if (process.env.ASPNETCORE_ENVIRONMENT !== "Development") {
    return c.json({ error: "DevPanel is only available in Development mode" }, 403);
  }
  await next();
});

// All dev endpoints require admin auth
devRouter.use("*", requireAdmin);

// GET /dev/event-types — list available mock event types
devRouter.get("/event-types", (c) => {
  return c.json({ eventTypes: [...EVENT_TYPES] });
});

// GET /dev/outbound-calls — captured outbound GitHub API calls
devRouter.get("/outbound-calls", (c) => {
  return c.json({ calls: getOutboundCalls(), active: isMockActive() });
});

// DELETE /dev/outbound-calls — clear captured calls
devRouter.delete("/outbound-calls", (c) => {
  clearOutboundCalls();
  return c.json({ cleared: true });
});

// GET /dev/mock-config — current mock overrides
devRouter.get("/mock-config", (c) => {
  return c.json({ overrides: getMockOverrides(), active: isMockActive() });
});

// PUT /dev/mock-config — set a mock override for a method
devRouter.put("/mock-config", async (c) => {
  const body = await c.req.json<{ method?: string; result?: unknown }>();
  if (!body.method) {
    return c.json({ error: "Missing 'method' field" }, 400);
  }
  setMockOverride(body.method, body.result);
  return c.json({ ok: true, overrides: getMockOverrides() });
});

// DELETE /dev/mock-config/:method — clear one override
devRouter.delete("/mock-config/:method", (c) => {
  const method = c.req.param("method");
  clearMockOverride(method);
  return c.json({ ok: true, overrides: getMockOverrides() });
});

// DELETE /dev/mock-config — clear all overrides
devRouter.delete("/mock-config", (c) => {
  clearAllOverrides();
  return c.json({ ok: true, overrides: {} });
});

// GET /dev/unmapped-slugs — list slugs in modlist without a CF mapping
devRouter.get("/unmapped-slugs", async (c) => {
  const ctx = buildUserFlowContext(c.get("oauthToken"), undefined);
  try {
    const result = await executeFlow<typeof dev_unmapped_slugs.input, typeof dev_unmapped_slugs.output>(
      dev_unmapped_slugs,
      ctx,
      { limit: 1000 },
    );
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e), total: 0, slugs: [] }, 500);
  }
});


// POST /dev/mock-webhook — trigger a mock webhook event
devRouter.post("/mock-webhook", async (c) => {
  const body = await c.req.json<{
    eventType?: string;
    prId?: number;
    payload?: Record<string, unknown>;
  }>();

  const eventType = body.eventType;
  const prId = body.prId ?? 1;

  if (!eventType || !EVENT_TYPES.includes(eventType as typeof EVENT_TYPES[number])) {
    return c.json({ error: `Invalid eventType. Valid: ${EVENT_TYPES.join(", ")}` }, 400);
  }

  // Build the Event object
  const payload = body.payload ?? buildDefaultPayload(eventType, prId);

  const event: WebhookEvent = {
    type: eventType,
    source: "mock",
    payload,
  };

  // Create mock deps
  const mockGithub = createMockGitHubClient();
  const config = getDevConfig();

  const deps = {
    github: mockGithub,
    logger: devLogger(),
    config,
  };
  // Activate capture, run dispatch (fire-and-forget), return immediately
  setMockActive(true);
  const registry = getSharedRegistry();

  // Convert the mock event to a stable DTO before dispatch
  const dto = eventToDto(event.type, event.payload);
  if (!dto) {
    devLogger().warn({ eventType }, "Mock event could not be converted to DTO — skipping dispatch");
    setMockActive(false);
    return c.json({ ok: false, error: `Event type ${eventType} could not be mapped to a DTO` }, 400);
  }

  dispatch(dto, deps, registry)
    .catch((err: Error) => {
      devLogger().error({ err: String(err), eventType, prId }, "mock dispatch 异常");
    })
    .finally(() => {
      setMockActive(false);
    });

  return c.json({
    ok: true,
    message: `Mock ${eventType} 已触发 (PR #${prId})`,
    prId,
    eventType,
    tip: `打开 /pr/${prId} 查看效果`,
  });
});

// ─── Default payload builder ────────────────────────────────────────

function buildDefaultPayload(eventType: string, prId: number): Record<string, unknown> {
  const base = {
    repository: {
      id: REPO.ID,
      name: REPO.NAME,
      owner: { login: REPO.OWNER },
    },
    sender: { login: "mock-tester", id: 999 },
  };

  switch (eventType) {
    case "pull_request.opened":
    case "pull_request.synchronize":
      return {
        ...base,
        action: eventType.split(".")[1],
        number: prId,
        pull_request: {
          number: prId,
          state: "open",
          title: "Mock PR: 翻译更新",
          user: { login: "mock-contributor", id: 100 },
          head: {
            sha: "mocksha123",
            ref: "mock-branch",
            repo: { owner: { login: "mock-contributor" } },
          },
          base: { ref: "main" },
        },
      };

    case "pull_request.labeled":
      return {
        ...base,
        action: "labeled",
        number: prId,
        label: { name: "size/M", id: 1, color: "ededed", description: "" },
      };

    case "pull_request.unlabeled":
      return {
        ...base,
        action: "unlabeled",
        number: prId,
        label: { name: "size/M", id: 1, color: "ededed", description: "" },
      };

    case "pull_request.edited":
      return {
        ...base,
        action: "edited",
        number: prId,
      };

    case "pull_request.closed":
      return {
        ...base,
        action: "closed",
        number: prId,
        pull_request: {
          number: prId,
          state: "closed",
          merged: false,
          user: { login: "mock-contributor", id: 100 },
        },
      };

    case "issue_comment.created":
    case "issue_comment.edited":
      return {
        ...base,
        action: eventType.split(".")[1],
        issue: { number: prId, pull_request: {} },
        comment: {
          id: Date.now(),
          body: "这是一条 mock 评论",
          user: { login: "mock-tester", id: 999 },
        },
      };

    case "workflow_run.completed":
      return {
        ...base,
        action: "completed",
        workflow: { name: "PR Packer" },
        workflow_run: {
          id: 12345,
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          head_branch: "mock-branch",
          head_repository: { owner: { login: "mock-contributor" } },
        },
      };

    default:
      return { ...base, number: prId };
  }
}
