// src/bootstrap/orchestrator.ts
// Top-level orchestrator — thin sequence of pure-phase calls.
// Each phase is a separate module in src/bootstrap/.

import type { EntryConfig } from "../config.js";
import type { Logger } from "../types.js";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { REQUIRED_DIRS } from "../config.js";
import { createDeps, type Deps } from "./deps.js";
import { createHonoApp } from "./app.js";
import { startServer } from "./server.js";
import { initRelation } from "../client/pr-relations-cache.js";
import * as prIndex from "../engine/pr-index.js";
import { createCronTasks } from "../cron-tasks/index.js";
import { startCronTasks } from "../cron.js";

/**
 * Bootstrap the server: ensure directories → create deps → register flows →
 * create app → mount routes → start Bun.serve → start cron → kick off background loading.
 *
 * External behavior (startup order, side effects, error handling) is identical
 * to the legacy monolithic bootstrap(); only the module layout has changed.
 */
export async function bootstrap(config: EntryConfig, logger: Logger): Promise<void> {
  for (const dir of REQUIRED_DIRS) {
    await mkdir(dir, { recursive: true });
  }
  // pi-agent 配置：extension 注册与 MCP server 在 config/pi-agent/（git 跟踪，
  // PI_CODING_AGENT_DIR env 指向）；此处不再生成配置。

  // glossary 二进制：幂等自动下载（存在即跳过；容器内 Dockerfile 已装到 /app/bin）。
  spawn(process.execPath, ["scripts/fetch-glossary.ts"], { stdio: "inherit", detached: false }).on(
    "error",
    (err) => logger.warn({ err }, "glossary fetch failed"),
  );

  const deps: Deps = await createDeps(config, logger);

  // Background: lazy-init PR relation map (slug->PR cross-reference)
  initRelation(deps.githubClient).catch((err) =>
    logger.warn({ err, source: 'bootstrap' }, "PR relation init failed - will lazy-init on first request"),
  );
  // Background: load PR index from disk
  prIndex.loadFromDisk().catch((err) =>
    logger.warn({ err, source: 'bootstrap' }, "PR index 加载失败，将使用空索引"),
  );

  // Cron: scheduled background tasks
  const cronTasks = createCronTasks({ registry: deps.registry, github: deps.githubClient, config, logger, fileStore: deps.fileStore });
  const stopCronTasks = startCronTasks(cronTasks, logger);

  // Create Hono app + mount routes
  const app = await createHonoApp(config, {
    webhookRouter: deps.webhook.router,
    sessionsRouter: deps.sessionsRouter,
  });

  // Start Bun.serve + SPA fallback
  startServer({ app, config, stopCron: stopCronTasks, logger, webhook: deps.webhook });
}
