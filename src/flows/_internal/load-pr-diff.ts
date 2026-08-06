import type { FlowContext } from "../../types.js";
import { PR_DIFF_MAX_BYTES } from "@/constants.js";
// src/flows/_internal/load-pr-diff.ts
// Cross-domain internal: load paginated PR diff and file list from GitHub.
// Normalizes renamed/deleted status values and enforces size limits.
// No Flow definition — called by multiple Flow execute() bodies.

import { FlowError, normalizeDiffFileStatus, wrapClientError } from "./types.js";
import type { DiffFile, DiffFileStatus, LoadPrDiffOptions, PrDiff } from "./types.js";
const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_BYTES = PR_DIFF_MAX_BYTES;

/**
 * Load PR files and raw diff from GitHubClient.
 *
 * Paginates through getPullRequestFiles and enforces:
 * - maxFiles: stop collecting files after this many
 * - maxBytes: stop collecting patch text after this byte count
 *
 * All three GitHub API calls (files, diff, PR) run in parallel.
 * Expected head SHA mismatch throws FlowError(STALE_HEAD).
 * Client errors are wrapped to FlowError with appropriate retryability.
 */
export async function loadPrDiff(
  ctx: FlowContext,
  options: LoadPrDiffOptions,
): Promise<PrDiff> {
  const {
    prNumber,
    expectedHeadSha,
    maxFiles = DEFAULT_MAX_FILES,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options;

  // Fetch files, raw diff, and PR metadata in parallel
  let prFiles, rawDiff, pr;
  try {
    [prFiles, rawDiff, pr] = await Promise.all([
      ctx.github.getPullRequestFiles(prNumber),
      ctx.github.getPullRequestDiff(prNumber),
      ctx.github.getPullRequest(prNumber),
    ]);
  } catch (err: unknown) {
    throw wrapClientError(err, `Failed to fetch diff for PR #${prNumber}`);
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

  // Normalize and limit files
  const files: DiffFile[] = [];
  let truncated = false;
  let byteCount = 0;

  for (const f of prFiles) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }

    const status = normalizeDiffFileStatus(f.status);
    const patchLen = f.patch?.length ?? 0;

    if (byteCount + patchLen > maxBytes) {
      truncated = true;
      files.push({
        filename: f.filename,
        status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      });
      break;
    }

    byteCount += patchLen;
    files.push({
      filename: f.filename,
      status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
    });
  }

  // Truncate raw diff if too large (best-effort — preserve available portion)
  const rawDiffTruncated =
    rawDiff.length > maxBytes
      ? rawDiff.slice(0, maxBytes) + "\n… [truncated]"
      : rawDiff;

  return {
    headSha,
    files,
    rawDiff: rawDiffTruncated,
    truncated,
  };
}

