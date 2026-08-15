// src/context.ts
// Build FlowContext from entry layer components.

import { REPO } from "./config.js";
import { createFileStore } from "./store.js";
import type {
  FileStore,
  FlowContext,
  Logger,
  EntryConfig,
  ScopedState,
} from "./types.js";
import type { GitHubClient } from "./client/github/index.js";

// Simple in-memory scoped state
export function createScopedState(): ScopedState {
  const scopes = new Map<string, Map<string, unknown>>();
  return {
    get<T>(scope: string, key: string): T | undefined {
      return scopes.get(scope)?.get(key) as T | undefined;
    },
    set<T>(scope: string, key: string, value: T): void {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope)!.set(key, value);
    },
    entries(scope: string): Record<string, unknown> {
      const s = scopes.get(scope);
      if (!s) return {};
      return Object.fromEntries(s.entries());
    },
  };
}

export interface EntryDependencies {
  github: GitHubClient;
  logger: Logger;
  config: EntryConfig;
  /** Shared persistence primitive. Defaults to a new FileStore only for
   *  tests/legacy callers; bootstrap must inject the shared instance. */
  store?: FileStore;
}

/**
 * Build a FlowContext for webhook-originated execution.
 *
 * @param ctxInit - Minimal event-like fields extracted from the webhook DTO.
 * @param deps    - Shared entry dependencies.
 * @param overrides - Optional overrides for actor/scope/invocation/signal.
 *                    Webhook callers MUST pass a detached (never-aborted) signal.
 */
export function buildContext(
  ctxInit: {
    type: string;
    source: string;
    payload: unknown;
  },
  deps: EntryDependencies,
  overrides?: {
    actor?: { kind: "admin" | "system"; login?: string };
    scope?: { prNumber?: number; baseSha?: string; headSha?: string };
    invocation?: { id: string; source: "agent" | "webhook" | "api" | "cron"; sessionId?: string; parentId?: string; deliveryId?: string };
    signal?: AbortSignal;
  },
): FlowContext {
  const payload = ctxInit.payload as Record<string, unknown> | undefined;
  const sender = payload?.sender as Record<string, unknown> | undefined;
  const prNumber = (payload?.number ?? (payload?.issue as Record<string, unknown> | undefined)?.number ?? 0) as number;
  const repoData = payload?.repository as
    | { owner?: { login?: string }; name?: string }
    | undefined;

  return {
    repo: {
      owner: repoData?.owner?.login ?? REPO.OWNER,
      name: repoData?.name ?? REPO.NAME,
      defaultBranch: REPO.DEFAULT_BRANCH,
    },
    actor: overrides?.actor ?? {
      kind: "system",
      login: (sender?.login as string | undefined),
    },
    scope: overrides?.scope ?? { prNumber: prNumber || undefined },
    invocation: overrides?.invocation ?? {
      id: crypto.randomUUID(),
      source: ctxInit.source as "webhook",
    },
    github: deps.github,
    store: deps.store ?? createFileStore(deps.logger),
    logger: deps.logger,
    config: deps.config,
    state: createScopedState(),
    signal: overrides?.signal ?? new AbortController().signal,
  };
}
