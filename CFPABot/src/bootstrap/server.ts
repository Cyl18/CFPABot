// src/bootstrap/server.ts
// Bun.serve + SPA fallback for production.
// Extracted from legacy bootstrap() end section.

import type { Server } from "bun";
import type { Logger } from "../types.js";
import type { Hono } from "hono";
import type { WebhookController } from "../api/webhook/route.js";
import type { EntryConfig } from "../config.js";
import { REPO } from "../config.js";

// In-flight webhook operations (git pushes, comment posts) must finish
// before exit — killing mid-push makes GitHub redeliver and re-execute.
const WEBHOOK_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Wire SIGTERM/SIGINT to graceful server shutdown:
 * set webhook shutdown flag → stop cron → stop server → exit(0).
 * Idempotent via shuttingDown guard.
 */
export function setupGracefulShutdown(
  server: ReturnType<typeof Bun.serve>,
  stopCron: () => void,
  logger: Logger,
  webhook: WebhookController,
): void {
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    webhook.setShuttingDown(true);
    logger.info({}, "开始关闭，等待 in-flight 操作...");
    stopCron();
    server.stop();
    // Drain started webhook operations (bounded) — server.stop() rejects
    // new connections but already-started dispatch/command ops are
    // fire-and-forget promises that must settle before exit.
    await webhook.waitForWebhookOps(WEBHOOK_DRAIN_TIMEOUT_MS);
    logger.info({}, "关闭完成");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export interface StartServerDeps {
  app: Hono;
  config: EntryConfig;
  stopCron: () => void;
  logger: Logger;
  webhook: WebhookController;
}

/**
 * Start Bun.serve with the given Hono app + SPA fallback.
 * Hono app takes precedence; unmatched non-API routes fall back to
 * public/index.html in production for SPA client-side routing.
 */
export function startServer(deps: StartServerDeps): ReturnType<typeof Bun.serve> {
  const { app, config, stopCron, logger, webhook } = deps;

  logger.info({ port: config.port, repo: `${REPO.OWNER}/${REPO.NAME}` }, "启动 CFPABot");

  const server = Bun.serve({
    port: config.port,
    // Disable idle timeout: Bun.serve default is 10s, which kills SSE connections
    // if no data is written during long tool executions. 0 = no timeout.
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      // HTTP -> Hono; SPA fallback for non-API routes (production only)
      const result = await app.fetch(req);

      if (
        config.environment === "production" &&
        result.status === 404 &&
        !url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/assets/") &&
        (req.headers.get("accept") ?? "").includes("text/html")
      ) {
        const indexHtml = Bun.file("public/index.html");
        if (await indexHtml.exists()) {
          const html = await indexHtml.text();
          return new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
      }

      return result;
    },
  });

  setupGracefulShutdown(server, stopCron, logger, webhook);

  return server;
}
