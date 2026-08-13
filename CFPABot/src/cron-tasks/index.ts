// src/cron-tasks/index.ts
// Barrel export + factory for all cron tasks.
// Each business task now uses executeFlow with registered Flows.

import crypto from "node:crypto";
import type { CronTask } from "@/cron.js";
import { buildContext } from "@/context.js";
import { executeFlow } from "@/engine/execute.js";
import type { FlowRegistry } from "@/engine/registry.js";
import type { EntryConfig } from "@/config.js";
import type { GitHubClient } from "@/client/github/index.js";
import type { Logger } from "@/types.js";
import { createModlistRefreshTask } from "./modlist-refresh.js";
import { createCurseforgeMappingTask } from "./curseforge-mapping.js";
import { createPrCacheRefreshTask } from "./pr-cache-refresh.js";
import { createCleanupTask } from "./cleanup.js";

export { createModlistRefreshTask } from "./modlist-refresh.js";
export { createCurseforgeMappingTask } from "./curseforge-mapping.js";
export { createPrCacheRefreshTask } from "./pr-cache-refresh.js";
export { createCleanupTask } from "./cleanup.js";

export interface CronTaskDeps {
  registry: FlowRegistry;
  github: GitHubClient;
  config: EntryConfig;
  logger: Logger;
}

/** Build a detached FlowContext for cron-originated Flow execution. */
function buildCronContext(deps: CronTaskDeps) {
  return buildContext(
    { type: "cron", source: "cron", payload: {} },
    { github: deps.github, logger: deps.logger, config: deps.config },
    {
      actor: { kind: "system" },
      scope: {},
      invocation: { id: crypto.randomUUID(), source: "cron" },
      signal: new AbortController().signal,
    },
  );
}

/** Create all cron tasks with the given dependencies. */
export function createCronTasks(deps: CronTaskDeps): CronTask[] {
  const tasks: CronTask[] = [
    createModlistRefreshTask(deps, () => buildCronContext(deps)),
    createPrCacheRefreshTask(deps, () => buildCronContext(deps)),
    createCleanupTask(deps.logger),
  ];

  if (process.env.CF_API_KEY) {
    tasks.push(createCurseforgeMappingTask(deps, () => buildCronContext(deps)));
  }

  return tasks;
}
