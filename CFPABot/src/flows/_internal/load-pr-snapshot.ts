// src/flows/_internal/load-pr-snapshot.ts
// Cross-domain internal: load and normalize a PR from GitHubClient into
// a stable PrSnapshot DTO. Validates expected head SHA if provided.
// No Flow definition — called by multiple Flow execute() bodies.

import type { FlowContext } from "../../types.js";
import { FlowError, wrapClientError } from "./types.js";
import type { PrSnapshot } from "./types.js";

export interface LoadPrSnapshotOptions {
  prNumber: number;
  expectedHeadSha?: string;
}

/**
 * Load a PR from GitHub and normalize into a stable business DTO.
 *
 * Validates expected head SHA if provided — mismatch throws FlowError(STALE_HEAD).
 * Labels are fetched from the issue search API since the PullRequest type
 * in this client does not carry labels directly.
 *
 * Propagation: ctx.signal is passed to async operations when the underlying
 * client API supports it (getPullRequest, searchIssues).
 */
export async function loadPrSnapshot(
  ctx: FlowContext,
  options: LoadPrSnapshotOptions,
): Promise<PrSnapshot> {
  const { prNumber, expectedHeadSha } = options;

  let pr;
  try {
    pr = await ctx.github.getPullRequest(prNumber);
  } catch (err: unknown) {
    throw wrapClientError(err, `Failed to fetch PR #${prNumber}`);
  }

  const headSha = pr.head.sha;
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    throw new FlowError({
      code: "STALE_HEAD",
      message: `Expected head SHA ${expectedHeadSha}, got ${headSha} for PR #${prNumber}`,
      publicMessage: `PR #${prNumber} head has changed (${headSha.slice(0, 7)}), expected ${expectedHeadSha.slice(0, 7)}. Refresh and retry.`,
      retryable: false,
    });
  }

  // Labels require a separate API call since PullRequest lacks them
  let labels: string[] = [];
  try {
    const result = await ctx.github.searchIssues(
      `repo:${ctx.repo.owner}/${ctx.repo.name} type:pr ${prNumber}`,
    );
    const match = result.items.find((i) => i.number === prNumber);
    if (match && match.labels) {
      labels = match.labels.map((l) => l.name);
    }
  } catch {
    // Non-critical — labels are best-effort
  }

  return {
    prNumber: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    state: pr.state,
    draft: pr.draft ?? false,
    head: { sha: headSha, ref: pr.head.ref },
    base: { sha: pr.base.sha ?? "", ref: pr.base.ref },
    author: pr.user ? { login: pr.user.login, id: pr.user.id } : null,
    labels,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  };
}
