// src/client/github/helpers.ts
// OAuth token exchange + raw content helpers (not part of GitHubClient interface).

import { AUTH } from "@/config.js";
import { RAW_FETCH_TIMEOUT_MS, OAUTH_EXCHANGE_TIMEOUT_MS } from "@/constants.js";

/** Workflow name for PR Packer filtering. */
export const PR_PACKER_NAME = "PR Packer";

/**
 * Exchange a GitHub OAuth code for an access token.
 * Used by the OAuth callback route.
 */
export async function exchangeOAuthCode(code: string): Promise<{
  accessToken: string;
  tokenType?: string;
  scope?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_EXCHANGE_TIMEOUT_MS);
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: AUTH.OAUTH_CLIENT_ID,
        client_secret: AUTH.OAUTH_CLIENT_SECRET,
        code,
      }),
      signal: controller.signal,
    });
    const data = (await res.json()) as Record<string, string>;
    if (!data.access_token) {
      throw new Error(`OAuth token exchange failed: ${data.error_description || data.error || "unknown"}`);
    }
    return { accessToken: data.access_token, tokenType: data.token_type, scope: data.scope };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build a raw.githubusercontent.com URL for a file in the repo.
 */
export function buildRawUrl(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): string {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${ref}`;
  return `${base}/${path}`;
}

/**
 * Build a raw.githubusercontent.com URL for a file at a specific commit SHA.
 * Unlike `buildRawUrl`, this uses the commit SHA directly rather than
 * `refs/heads/<branch>`, making it suitable for deterministic blob access.
 */
export function buildRawBlobUrl(
  owner: string,
  repo: string,
  path: string,
  sha: string,
): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`;
}

/**
 * Fetch raw text content from a URL (raw.githubusercontent.com or other).
 * For public repos - no auth needed.
 *
 * - 404 → returns null (resource doesn't exist)
 * - Other HTTP errors / network issues → throws
 */
export async function fetchRawContent(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`fetchRawContent failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Check if a raw URL exists (HEAD probe).
 * Returns true if the URL returns a 2xx status.
 */
export async function checkRawExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}
