// src/flows/git/_internal/revert-commit.ts
// Git-domain internal: revert a specific commit in a PR branch.
// No Flow definition — used by git_revert_commit execute().
//
// Revert is special among workspace operations because `git revert` itself
// creates a commit. We therefore manage the workspace lifecycle directly
// (clone, validate HEAD, revert, push, cleanup) rather than using
// withPrWorkspace's mutate → commit → push pattern.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { acquireLock } from "@/engine/lock.js";
import { ensureRepo, push, getHeadSha } from "@/client/git.js";

const REPO_URL_TEMPLATE = "https://github.com/{owner}/{repo}.git";

export interface RevertResult {
  revertCommitSha: string;
  conflictFiles?: string[];
}

/**
 * Revert a target commit in a PR branch.
 *
 * 1. Acquires branch lock.
 * 2. Clones/fetches the PR branch (deep enough for revert — up to 50 commits).
 * 3. Validates HEAD matches expected SHA.
 * 4. Performs `git revert --no-edit <targetCommitSha>`.
 * 5. On conflict: returns conflict file list without pushing; cleans up.
 * 6. On success: pushes; cleans up.
 */
export async function revertCommitInWorkspace(
  ctx: FlowContext,
  prNumber: number,
  expectedHeadSha: string,
  targetCommitSha: string,
): Promise<RevertResult> {
  // Validate target SHA
  if (!targetCommitSha || targetCommitSha.length < 6) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Invalid target commit SHA: ${targetCommitSha}`,
      publicMessage: "The target commit SHA appears to be invalid.",
      retryable: false,
    });
  }

  // Fetch PR to obtain head ref
  let pr;
  try {
    pr = await ctx.github.getPullRequest(prNumber);
  } catch (err: unknown) {
    throw wrapError(err, `Failed to fetch PR #${prNumber}`);
  }

  const headSha = pr.head.sha;
  if (headSha !== expectedHeadSha) {
    throw new FlowError({
      code: "STALE_HEAD",
      message: `Expected head SHA ${expectedHeadSha}, got ${headSha} for PR #${prNumber}`,
      publicMessage: `PR #${prNumber} head has changed (${headSha.slice(0, 7)}). Refresh and retry.`,
      retryable: false,
    });
  }

  const branchName = pr.head.ref;
  const lockKey = `git-workspace:${ctx.repo.owner}/${ctx.repo.name}/${branchName}`;
  const repoUrl = REPO_URL_TEMPLATE
    .replace("{owner}", ctx.repo.owner)
    .replace("{repo}", ctx.repo.name);

  const release = await acquireLock(lockKey);
  const tmpDir = await mkdtemp(join(tmpdir(), `cfpa-revert-${prNumber}-`));

  try {
    ctx.logger.info(
      { prNumber, operationName: "git_revert_commit", branchName },
      "Acquired lock, cloning PR branch for revert",
    );

    // Clone with enough history for the revert (fetch up to 50 commits deep)
    const repoHandle = await ensureRepo(repoUrl, tmpDir, branchName, ctx.signal);

    // Re-verify HEAD after clone
    const actualSha = await getHeadSha(repoHandle);
    if (actualSha !== expectedHeadSha) {
      throw new FlowError({
        code: "STALE_HEAD",
        message: `Workspace HEAD is ${actualSha}, expected ${expectedHeadSha}`,
        publicMessage: `PR #${prNumber} head changed before revert. Refresh and retry.`,
        retryable: false,
      });
    }

    // Verify target commit is reachable from HEAD
    const subject = await getCommitSubject(tmpDir, targetCommitSha, ctx.signal);

    // Perform the revert
    const { status, stderr } = await runGitRaw(tmpDir, [
      "revert", "--no-edit", targetCommitSha,
    ], ctx.signal);

    if (status !== 0) {
      // Check for conflicts
      if (stderr.includes("CONFLICT") || stderr.includes("conflict")) {
        const conflictFiles = await listConflictFiles(tmpDir, ctx.signal);
        // Abort the revert to leave workspace clean
        await runGitRaw(tmpDir, ["revert", "--abort"], ctx.signal).catch(() => {});
        return { revertCommitSha: "", conflictFiles };
      }

      throw new FlowError({
        code: "FAILED",
        message: `git revert failed: ${stderr.slice(0, 500)}`,
        publicMessage: "The revert could not be completed. The git operation reported an error.",
        retryable: false,
      });
    }

    const revertCommitSha = await getHeadSha(repoHandle, ctx.signal);

    // Push
    await push(repoHandle, ctx.signal);

    ctx.logger.info(
      { prNumber, operationName: "git_revert_commit", revertCommitSha, targetSha: targetCommitSha },
      "Revert committed and pushed",
    );

    return { revertCommitSha };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────

/** Run a git command in the given directory, returning status + stderr. */
async function runGitRaw(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => proc.kill();
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const status = await proc.exited;
    return { status, stdout, stderr };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Get the commit subject line (first line of message) for a given SHA. */
async function getCommitSubject(cwd: string, sha: string, signal?: AbortSignal): Promise<string> {
  const { status, stdout } = await runGitRaw(cwd, [
    "log", "-1", "--format=%s", sha,
  ], signal);
  if (status !== 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Commit ${sha} not found or not reachable`,
      publicMessage: `The target commit "${sha.slice(0, 7)}" is not reachable from the PR branch. It may not exist or may belong to a different branch.`,
      retryable: false,
    });
  }
  return stdout.trim();
}

/** List conflicted files after a failed merge/revert. */
async function listConflictFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await runGitRaw(cwd, ["diff", "--name-only", "--diff-filter=U"], signal);
  return stdout.trim().split("\n").filter(Boolean);
}

/** Wrap errors from GitHub client calls. */
function wrapError(err: unknown, fallbackMessage: string): FlowError {
  const message = err instanceof Error ? err.message : String(err);
  return new FlowError({
    code: "UPSTREAM_UNAVAILABLE",
    message: `${fallbackMessage}: ${message}`,
    publicMessage: fallbackMessage,
    retryable: true,
  });
}
