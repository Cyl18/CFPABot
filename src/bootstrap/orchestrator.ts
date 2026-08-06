// src/bootstrap/orchestrator.ts
// Top-level orchestrator — thin sequence of pure-phase calls.
// Each phase is a separate module in src/bootstrap/.

import type { EntryConfig } from "../config.js";
import type { Logger } from "../types.js";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_DIRS, AGENT_SETTINGS_PATH } from "../config.js";
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
  // Pi agent settings — 幂等初始化：注册 pi-mcp-adapter extension（标准 Pi settings 机制，
  // 与 `pi install` 等价；MCP server 配置在项目 .mcp.json，加 server 无需改代码）。
  // 注意：global scope 的相对路径以 agentDir 为基准解析，这里必须用绝对路径。
  if (!existsSync(AGENT_SETTINGS_PATH)) {
    await writeFile(
      AGENT_SETTINGS_PATH,
      JSON.stringify({ extensions: [join(process.cwd(), "node_modules/pi-mcp-adapter")] }, null, 2) + "\n",
      "utf-8",
    );
  }

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
  const cronTasks = createCronTasks({ registry: deps.registry, github: deps.githubClient, config, logger });
  const stopCronTasks = startCronTasks(cronTasks, logger);

  // Create Hono app + mount routes
  const app = await createHonoApp(config);

  // Start Bun.serve + SPA fallback
  startServer({ app, config, stopCron: stopCronTasks, logger });
}
