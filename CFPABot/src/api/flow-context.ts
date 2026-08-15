// src/api/flow-context.ts
// Build a FlowContext for API-initiated or session-originated execution.
// Single factory for FlowContext construction — parameterized by source
// and optional user identity. Previously split across two near-identical
// factories (createApiFlowContext + createSessionFlowContext); unified to
// eliminate the duplicated object literal and keep behavior identical.

import { REPO } from "@/config.js";
import { createFileStore } from "@/store.js";
import { createScopedState } from "@/context.js";
import { createUserTokenGitHubClient } from "@/client/github/index.js"
import type { FileStore, FlowContext, Logger, EntryConfig } from "@/types.js"
import type { GitHubClient, GitHubUser } from "@/client/github/index.js"

/**
 * Build a fully-formed FlowContext from minimal inputs.
 *
 * Construction variants (all delegate to this factory):
 *   - API init from user token:  buildUserFlowContext(token?, user?)
 *     → source="api", github = createUserTokenGitHubClient(token)
 *   - Session init:             createSessionFlowContext(github, config, logger, source?)
 *     → source provided by caller (agent|webhook|api|cron)
 *
 * The shared literal keeps all FlowContext invariants (repo, store, state,
 * signal) in one place — no per-variant drift.
 */
export function createApiFlowContext(
  github: GitHubClient,
  config: EntryConfig,
  logger: Logger,
  user?: GitHubUser,
  source: "agent" | "webhook" | "api" | "cron" = "api",
  store?: FileStore,
): FlowContext {
  return {
    repo: {
      owner: REPO.OWNER,
      name: REPO.NAME,
      defaultBranch: REPO.DEFAULT_BRANCH,
    },
    actor: {
      kind: "admin",
      login: user?.login,
    },
    scope: {},
    invocation: {
      id: crypto.randomUUID(),
      source,
    },
    github,
    store: store ?? createFileStore(logger),
    logger,
    config,
    state: createScopedState(),
    signal: new AbortController().signal,
  };
}

// ---- Shared deps (set once at startup, used by all API routes) ----

let _apiConfig: EntryConfig | null = null;
let _apiLogger: Logger | null = null;
let _appClient: GitHubClient | null = null;
let _apiFileStore: FileStore | null = null;

/** Set shared config + logger + App-install client for API-initiated Flow
 *  execution. Called once at startup. `appClient` is used for anonymous
 *  requests (no OAuth token) — never falls back to shared PATs. */
export function initApiDeps(
  config: EntryConfig,
  logger: Logger,
  appClient?: GitHubClient,
  fileStore?: FileStore,
): void {
  _apiConfig = config;
  _apiLogger = logger;
  _appClient = appClient ?? null;
  _apiFileStore = fileStore ?? null;
}

export function getApiConfig(): EntryConfig {
  if (!_apiConfig) throw new Error("initApiDeps not called — API deps not initialized");
  return _apiConfig;
}

export function getApiLogger(): Logger {
  if (!_apiLogger) throw new Error("initApiDeps not called — API deps not initialized");
  return _apiLogger;
}

/**
 * Build user-token API FlowContext — convenience wrapper over createApiFlowContext.
 * Primary entry point for /api/frontend/* routes.
 * Anonymous requests (no token) use the injected App-install client so public
 * read-only routes keep working without silently sharing a PAT identity.
 */
export function buildUserFlowContext(token?: string, user?: GitHubUser): FlowContext {
  const github = token ? createUserTokenGitHubClient(token, getApiLogger()) : _appClient;
  if (!github) {
    throw new Error("initApiDeps 未注入 appClient，匿名请求无法构建 FlowContext");
  }
  return createApiFlowContext(
    github,
    getApiConfig(),
    getApiLogger(),
    user,
    "api",
    _apiFileStore ?? undefined,
  );
}

/**
 * Build a FlowContext for agent sessions — delegates to the unified factory.
 * Kept as a separate function for semantic clarity (sessions use a pre-built
 * githubClient and a source that is not always "api").
 */
export function createSessionFlowContext(
  githubClient: GitHubClient,
  config: EntryConfig,
  logger: Logger,
  source: "agent" | "webhook" | "api" | "cron" = "agent",
  store?: FileStore,
): FlowContext {
  return createApiFlowContext(githubClient, config, logger, undefined, source ?? "agent", store);
}
