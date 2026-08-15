// src/flows/_internal/with-pr-workspace.ts
// Cross-domain internal: create a local Git workspace for safe PR mutations.
// Acquires branch lock using the actual PR head ref, clones/fetches, validates
// expected head SHA, runs a bounded mutation callback, commits with the
// explicitly provided message, pushes, then cleans up.
// No Flow definition — used by all file/git mutation Flow execute() bodies.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlowContext } from "../../types.js";
import { acquireLock } from "@/engine/lock.js";
import { FlowError, wrapClientError } from "./types.js";
import type {
  WorkspaceOptions,
  WorkspaceMutateResult,
  WorkspaceHandle,
} from "./types.js";
import {
  ensureRepo,
  commit,
  push,
  getHeadSha,
} from "../../client/git.js";

const REPO_URL_TEMPLATE = "https://github.com/{owner}/{repo}.git";

/**
 * Execute a mutation within a safe PR workspace.
 *
 * Flow:
 * 1. Fetch PR from GitHub to obtain the actual head ref (branch name).
 * 2. Acquire branch keyed lock: `git-workspace:{owner}/{repo}/{branch}`.
 * 3. Create an OS temp directory (async, no sync FS).
 * 4. Clone/fetch the PR branch into the temp directory.
 * 5. Validate HEAD matches expected SHA; mismatch → FlowError(STALE_HEAD).
 * 6. Call `mutate(handle)` — the callback receives only the workspace dir
 *    and MUST confine file changes to that directory. It MUST NOT access
 *    the remote URL, auth config, or run model-generated shell commands.
 * 7. Check `git status --porcelain` — no changes → return skipped.
 * 8. Commit with the explicitly provided commitMessage.
 * 9. Push to remote.
 * 10. Return commit SHA.
 * 11. Finally: cleanup temp dir and release lock.
 *
 * Cancellation: ctx.signal propagates to git subprocesses; client/git.ts
 * kills the spawned git process on abort (including clone/fetch/commit/push).
 *
 * @param ctx     FlowContext (repo, actor, signal, logger)
 * @param options Workspace parameters including explicit commitMessage
 * @param mutate  Bounded mutation callback (receives { dir })
 */
export async function withPrWorkspace(
  ctx: FlowContext,
  options: WorkspaceOptions,
  mutate: (handle: WorkspaceHandle) => Promise<void>,
): Promise<WorkspaceMutateResult> {
  const { prNumber, expectedHeadSha, operationName, commitMessage } = options;

  if (!commitMessage || commitMessage.trim().length === 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "commitMessage must be non-empty",
      publicMessage: "Commit message cannot be empty.",
      retryable: false,
    });
  }

  // 1. Fetch PR to obtain the actual head ref (branch name)
  let pr;
  try {
    pr = await ctx.github.getPullRequest(prNumber);
  } catch (err: unknown) {
    throw wrapClientError(err, `Failed to fetch PR #${prNumber}`);
  }

  const headSha = pr.head.sha;
  if (headSha !== expectedHeadSha) {
    throw new FlowError({
      code: "STALE_HEAD",
      message: `Expected head SHA ${expectedHeadSha}, got ${headSha} for PR #${prNumber}`,
      publicMessage: `PR #${prNumber} head has changed (${headSha.slice(0, 7)}), expected ${expectedHeadSha.slice(0, 7)}. Refresh and retry.`,
      retryable: false,
    });
  }

  const branchName = pr.head.ref;
  const lockKey = `git-workspace:${ctx.repo.owner}/${ctx.repo.name}/${branchName}`;

  // 2. Acquire branch lock
  const release = await acquireLock(lockKey);

  // 3. Create temp directory (async, under OS tmpdir)
  const tmpDir = await mkdtemp(join(tmpdir(), `cfpa-workspace-${prNumber}-`));
  try {
    ctx.logger.info(
      { prNumber, operationName, branchName, tmpDir },
      "Acquired workspace lock, cloning PR branch",
    );

    const repoUrl = REPO_URL_TEMPLATE
      .replace("{owner}", ctx.repo.owner)
      .replace("{repo}", ctx.repo.name);

    // 4. Clone/fetch PR branch
    const repoHandle = await ensureRepo(repoUrl, tmpDir, branchName, ctx.signal);

    // 5. Re-verify HEAD SHA after clone (defence-in-depth)
    const actualSha = await getHeadSha(repoHandle);
    if (actualSha !== expectedHeadSha) {
      throw new FlowError({
        code: "STALE_HEAD",
        message: `Workspace HEAD is ${actualSha}, expected ${expectedHeadSha}`,
        publicMessage: `PR #${prNumber} head changed before mutation. Refresh and retry.`,
        retryable: false,
      });
    }

    // 6. Run bounded mutation callback
    await mutate({ dir: tmpDir });

    // 7. Check for changes
    const hasChanges = await checkGitStatus(tmpDir, ctx.signal);

    if (!hasChanges) {
      ctx.logger.info(
        { prNumber, operationName },
        "No changes detected in workspace, skipping commit",
      );
      return { skipped: true };
    }

    // 8-9. Commit with explicit message, then push
    const commitSha = await commit(
      repoHandle,
      commitMessage.trim(),
      ctx.actor.login ?? "cfpa-bot",
      ctx.signal,
    );
    await push(repoHandle, ctx.signal);

    ctx.logger.info(
      { prNumber, operationName, commitSha },
      "Workspace mutation committed and pushed",
    );

    return { skipped: false, commitSha };
  } finally {
    // 11. Cleanup + release (always runs)
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch (err: unknown) {
      ctx.logger.warn(
        { tmpDir, error: err instanceof Error ? err.message : String(err) },
        "Failed to clean up workspace temp directory",
      );
    }
    release();
    ctx.logger.info(
      { prNumber, operationName },
      "Released workspace lock",
    );
  }
}

// ──────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────

/**
 * Run `git status --porcelain` and return true if there are any changes.
 * Fails safe: returns true on non-zero exit or spawn error.
 */
async function checkGitStatus(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
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
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return exitCode === 0 ? output.trim().length > 0 : true;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  } catch {
    return true;
  }
}


