// src/bootstrap/deps.ts
// Create all service dependencies at startup.
// Extracted from legacy bootstrap() §1-§3 (core infrastructure, review-run infra, flow registry).

import type { EntryConfig } from "../config.js";
import type { Logger } from "../types.js";
import { getOrCreateEncryptKey, initEncryptKey } from "../api/auth.js";
import { createFileStore } from "../store.js";
import { createAuthenticatedOctokit, createPersonalOctokit } from "../client/github-app-auth.js";
import { createGitHubClient } from "../client/github/index.js";
import { SessionService } from "../agent/session-service.js";
import { PiSessionManager } from "../agent/session-manager.js";
import { initApiDeps } from "../api/flow-context.js";
import { initPrCacheLogger } from "../client/pr-relations-cache.js";
import { initGitLogger } from "../client/git.js";
import { initRegistryLogger } from "../engine/registry.js";
import { initPrIndexLogger } from "../engine/pr-index.js";
import { initWebhookRoutes } from "../api/webhook/route.js";
import { initSessionRoutes } from "../api/sessions.js";
import { createSessionFlowContext } from "../api/flow-context.js";
import { REPO } from "../config.js";
import type { FlowRegistry } from "../engine/registry.js";
import type { GitHubClient } from "../client/github/index.js";
import { registerFlows, type FlowDeps } from "./flows.js";

/**
 * All service dependencies created at startup.
 * Passed explicitly to app creation and route initialization.
 */
export interface Deps {
  config: EntryConfig;
  logger: Logger;
  githubClient: GitHubClient;
  fileStore: ReturnType<typeof createFileStore>;
  sessionService: SessionService;
  piSessionManager: PiSessionManager;
  registry: FlowRegistry;
}

/**
 * Create all service dependencies in the correct order.
 * Order matters:
 *   1. encrypt key (before any middleware runs)
 *   2. GitHub clients + FileStore
 *   3. SessionService + PiSessionManager (SSE wiring)
 *   4. FlowRegistry + flow registration
 *   5. initApiDeps (so routes can build user flow contexts)
 *   6. Route init (initWebhookRoutes, initSessionRoutes)
 */
export async function createDeps(config: EntryConfig, logger: Logger): Promise<Deps> {
  // Pre-load encrypt key for OAuth cookies — must happen before any middleware runs
  const encryptKey = await getOrCreateEncryptKey();
  initEncryptKey(encryptKey);

  const octokit = createAuthenticatedOctokit({
    appId: config.githubAppId,
    pemKey: config.pemKey,
    installationId: config.githubAppInstallationId,
  }, logger);
  const personalOctokit = createPersonalOctokit(config.personalAccessToken, logger);
  if (!config.personalAccessToken) {
    logger.warn({}, "GITHUB_OAUTH_TOKEN 未设置，Gist/GraphQL 等个人操作将不可用");
  }
  const githubClient = createGitHubClient(octokit, personalOctokit, logger);
  // Wire module-level loggers (client/engine modules that used console.*)
  initPrCacheLogger(logger);
  initGitLogger(logger);
  initRegistryLogger(logger);
  initPrIndexLogger(logger);
  // FileStore is the single persistence primitive for everything
  const fileStore = createFileStore(logger);

  // SessionService — constructed early so webhook /agent can create sessions.
  // No boot-time bulk load: sessions are loaded lazily on first access that
  // needs the in-memory map (list / create). Cold start is O(1).
  const sessionService = new SessionService(fileStore, logger);
  // PiSessionManager (AgentSession + SSE) — wired to SessionService
  const piSessionManager = new PiSessionManager(sessionService, logger);
  // Wire SSE callback from SessionService → PiSessionManager
  sessionService.sseBroadcast = (sessionId, event) => {
    piSessionManager.broadcast(sessionId, event);
  };

  // ─── 3. Flow Registry + Flow creation ─────────────────────────
  const flowDeps: FlowDeps = {
    sessionService,
  };
  const registry = registerFlows(flowDeps, config, logger);


  // Initialize shared API deps (config + logger) so that api/ routes and
  // background tasks can build user flow contexts without crashing.
  // ⚠️ Order dependency: initApiDeps MUST be called before any route handler
  //   that uses buildUserFlowContext / getApiConfig / getApiLogger.
  initApiDeps(config, logger, githubClient);

  // ─── 4. Route initialization ──────────────────────────────────

  // Webhook routes with session creator for /agent-review
  initWebhookRoutes(githubClient, logger, config, registry, {
    createSession: async (params) => {
      const { session, created } = await sessionService.createOrGetSession({
        source: "github_command",
        createdBy: { login: params.login, githubId: params.githubId },
        repo: { owner: REPO.OWNER, name: REPO.NAME },
        prNumber: params.prNumber,
        baseSha: params.baseSha,
        headSha: params.headSha,
        objective: params.objective,
        dedupKey: params.dedupKey,
      });
      return { sessionId: session.sessionId, created };
    },
    startSession: async (sessionId) => {
      const ctx = createSessionFlowContext(githubClient, config, logger, "webhook");
      const session = await sessionService.getSession(sessionId);
      if (session) {
        ctx.scope = { prNumber: session.prNumber, baseSha: session.baseSha, headSha: session.headSha };
      }
      await piSessionManager.startSession(sessionId, ctx);
    },
  });

  // SSE session routes with SessionService + manager
  initSessionRoutes({
    githubClient,
    config,
    logger,
    sessionService,
    agentSessionManager: piSessionManager,
  });

  return {
    config,
    logger,
    githubClient,
    fileStore,
    sessionService,
    piSessionManager,
    registry,
  };
}
