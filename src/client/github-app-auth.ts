// src/client/github-app-auth.ts
// GitHub App authentication: PEM → JWT → Installation Token → Octokit
// Dual-client pattern aligned with ref .NET repo: Instance (App) + InstancePersonal (PAT)

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { Logger } from "../types.js";

const MyOctokit = Octokit.plugin(retry, throttling);

/**
 * Create an authenticated Octokit client using GitHub App credentials.
 * Tokens auto-refresh (~1 hour lifespan, refreshed proactively).
 * Equivalent to ref .NET `GitHub.Instance`.
 */
export function createAuthenticatedOctokit(options: {
  appId: number;
  pemKey: string;
  installationId: number;
}, logger?: Logger): Octokit {
  return new MyOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: options.appId,
      privateKey: options.pemKey,
      installationId: options.installationId,
    },
    throttle: {
      onRateLimit: (retryAfter: number, options: object) => {
        logger?.warn({ retryAfter }, "[github] Rate limited, retrying");
        return true;
      },
      onSecondaryRateLimit: (retryAfter: number, options: object) => {
        logger?.warn({ retryAfter }, "[github] Secondary rate limited, retrying");
        return true;
      },
    },
    request: { retries: 5 },
  });
}

export function createPersonalOctokit(pat: string | undefined, logger?: Logger): Octokit | null {
  if (!pat) return null;
  return new MyOctokit({
    auth: pat,
    throttle: {
      onRateLimit: (retryAfter: number) => {
        logger?.warn({ retryAfter }, "[github] Personal PAT rate limited, retrying");
        return true;
      },
      onSecondaryRateLimit: (retryAfter: number) => {
        logger?.warn({ retryAfter }, "[github] Personal PAT secondary rate limited, retrying");
        return true;
      },
    },
    request: { retries: 5 },
  });
}

/**
 * Create a user-scoped Octokit from an OAuth token.
 * Never falls back to env-var PATs — callers must pass a real token
 * (anonymous API requests use the App installation client instead).
 */
export function createUserOctokit(token?: string, logger?: Logger): Octokit {
  if (!token) {
    throw new Error("GitHub OAuth token is required for user-scoped requests");
  }
  return new MyOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter: number) => {
        logger?.warn({ retryAfter }, "[github] User token rate limited, retrying");
        return true;
      },
      onSecondaryRateLimit: (retryAfter: number) => {
        logger?.warn({ retryAfter }, "[github] User token secondary rate limited, retrying");
        return true;
      },
    },
    request: { retries: 5 },
  });
}
