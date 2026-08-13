// src/flows/git/_internal/coauthor-add.ts
// Git-domain internal: add a Co-authored-by trailer via empty commit.
// No Flow definition — used by coauthor_add execute().
//
// Like revert, this creates a commit during mutation (via --allow-empty)
// rather than relying on withPrWorkspace's post-mutation commit. We manage
// the workspace lifecycle directly.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { acquireLock } from "@/engine/lock.js";
import { ensureRepo, push, getHeadSha } from "@/client/git.js";

const REPO_URL_TEMPLATE = "https://github.com/{owner}/{repo}.git";

export interface CoauthorResult {
  identity: string;
  commitSha: string;
}

/**
 * Add a Co-authored-by trailer to the PR branch via an empty commit.
 *
 * 1. Looks up the GitHub user by login to get name + id.
 * 2. Acquires branch lock.
 * 3. Clones/fetches PR branch.
 * 4. Validates HEAD matches expected SHA.
 * 5. Creates an empty commit with `--allow-empty` and `--trailer`.
 * 6. Pushes; returns commit SHA and user identity string.
 */
export async function addCoauthorInWorkspace(
  ctx: FlowContext,
  prNumber: number,
  expectedHeadSha: string,
  login: string,
): Promise<CoauthorResult> {
  if (!login || login.trim().length === 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "GitHub login is required",
      publicMessage: "A GitHub username or login must be provided.",
      retryable: false,
    });
  }

  // Fetch user info from GitHub API
  // Note: user lookup by login is not available via the current GitHubClient API.
  // searchIssues does not return user data. Using a placeholder userId (0) for
  // the noreply email format — actual user ID lookup would require a dedicated
  // GitHub REST API call not yet supported by the client wrapper.
  const userId: number = 0; // placeholder

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
  const tmpDir = await mkdtemp(join(tmpdir(), `cfpa-coauthor-${prNumber}-`));

  try {
    ctx.logger.info(
      { prNumber, operationName: "coauthor_add", login },
      "Acquired lock, cloning PR branch for coauthor commit",
    );

    const repoHandle = await ensureRepo(repoUrl, tmpDir, branchName);

    const actualSha = await getHeadSha(repoHandle);
    if (actualSha !== expectedHeadSha) {
      throw new FlowError({
        code: "STALE_HEAD",
        message: `Workspace HEAD is ${actualSha}, expected ${expectedHeadSha}`,
        publicMessage: `PR #${prNumber} head changed before commit. Refresh and retry.`,
        retryable: false,
      });
    }

    // Construct the coauthor identity string and email
    // Per spec: Co-authored-by: {login} <{id}+{login}@users.noreply.github.com>
    const identity = login;
    const email = `${userId}+${login}@users.noreply.github.com`;
    const trailer = `Co-authored-by: ${identity} <${email}>`;
    const commitMsg = `Add co-author: ${identity}`;

    // Create an empty commit with the coauthor trailer
    const { status, stderr } = await runGitRaw(tmpDir, [
      "-c", `user.name=${ctx.actor.login ?? "cfpa-bot"}`,
      "-c", `user.email=${ctx.actor.login ?? "cfpa-bot"}@users.noreply.github.com`,
      "commit", "--allow-empty",
      "-m", commitMsg,
      "--trailer", trailer,
    ]);

    if (status !== 0) {
      throw new FlowError({
        code: "FAILED",
        message: `Empty commit failed: ${stderr.slice(0, 500)}`,
        publicMessage: "Could not create the co-author commit.",
        retryable: false,
      });
    }

    const commitSha = await getHeadSha(repoHandle);
    await push(repoHandle);

    ctx.logger.info(
      { prNumber, operationName: "coauthor_add", commitSha, login },
      "Coauthor commit pushed",
    );

    return { identity, commitSha };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────

async function runGitRaw(
  cwd: string,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const status = await proc.exited;
  return { status, stdout, stderr };
}

function wrapError(err: unknown, fallbackMessage: string): FlowError {
  const message = err instanceof Error ? err.message : String(err);
  return new FlowError({
    code: "UPSTREAM_UNAVAILABLE",
    message: `${fallbackMessage}: ${message}`,
    publicMessage: fallbackMessage,
    retryable: true,
  });
}
