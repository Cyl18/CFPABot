// src/__tests__/helpers/mock-context.ts
// Factory for FlowContext objects used in engine contract tests.

import { createFileStore } from "@/store.js";
import { createScopedState } from "@/context.js";
import type { FlowContext } from "@/types.js";
import type { GitHubClient } from "@/client/github/types.js";
import type { Logger } from "@/types.js";
import type { EntryConfig } from "@/config.js";

let nextInvId = 1;

/**
 * Build a minimal FlowContext for engine-contract testing.
 * Overrides let each test supply only the fields it cares about.
 * github and logger are no-op stubs that throw when called — contract tests
 * must not depend on external API responses.
 */
export function createMockContext(
  overrides?: Partial<FlowContext>,
): FlowContext {
  const invId = `test-inv-${nextInvId++}`;

  return {
    repo: {
      owner: "CFPAOrg",
      name: "Minecraft-Mod-Language-Package",
      defaultBranch: "main",
    },
    actor: { kind: "system" },
    scope: {},
    invocation: {
      id: invId,
      // "webhook" literal satisfies InvocationSource; `as const` prevents
      // widening to plain string — a type annotation would re-widen.
      source: "webhook" as const,
    },
    github: createNoopGitHubClient(),
    store: createFileStore(),
    logger: createNoopLogger(),
    config: createMinimalConfig(),
    state: createScopedState(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ─── No-op stubs ───────────────────────────────────────────────────

function createNoopGitHubClient(): GitHubClient {
  // Proxy intercepts any method call — contract tests must not depend
  // on specific GitHub API responses, so all calls throw.
  const proxyTarget: Record<string, unknown> = {};
  // Double-cast is required because the Proxy's dynamic type doesn't
  // structurally match the large GitHubClient interface. No method is
  // ever called in engine-contract tests that reach this stub.
  const stub = new Proxy(proxyTarget, {
    get(_target, _prop: string) {
      return async () => {
        throw new Error(
          "GitHubClient stub called in engine-contract test — " +
          "this test should not depend on external API responses.",
        );
      };
    },
  }) as unknown as GitHubClient;
  return stub;
}

function createNoopLogger(): Logger {
  const noop = () => {};
  const logger: Logger = { info: noop, warn: noop, error: noop, debug: noop };
  return logger;
}

function createMinimalConfig(): EntryConfig {
  const cfg: EntryConfig = {
    owner: "CFPAOrg",
    repoName: "Minecraft-Mod-Language-Package",
    repoId: 88008282,
    repoUrl: "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package",
    defaultBranch: "main",
    webhookSecret: "",
    personalAccessToken: "",
    githubAppId: 0,
    githubAppPemPath: "",
    githubAppInstallationId: 0,
    port: 0,
    environment: "development",
    logLevel: "error",
    oauthClientId: "",
    oauthTokenCookieName: "oauth-token-enc",
    pemKey: "",
    reviewPublishEnabled: true,
  };
  return cfg;
}
