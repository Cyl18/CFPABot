// src/flows/git/coauthor_add.ts
// Flow: coauthor_add — add a Co-authored-by trailer via empty commit.
// Risk: repository_write | Effects: git_commit, git_push
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §8.2
//
// Creates an empty commit with --allow-empty and a Co-authored-by trailer.
// Looks up the GitHub user by login to construct the canonical noreply email:
//   {id}+{login}@users.noreply.github.com

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { addCoauthorInWorkspace } from "./_internal/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "@/engine/lock.js";
import { ensureRepo, push, getHeadSha } from "@/client/git.js";

const REPO_URL_TEMPLATE = "https://github.com/{owner}/{repo}.git";

// ─── Input Schema ──────────────────────────────────────────────────────

export const coauthor_add_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  login: Type.String({
    description: "GitHub login/username of the co-author",
  }),
});

export type CoauthorAddInput = Static<typeof coauthor_add_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const coauthor_add_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created empty commit" }),
  identity: Type.String({
    description: "User identity string (login for the co-author)",
  }),
});

export type CoauthorAddOutput = Static<typeof coauthor_add_output>;


// ─── Flow Definition ───────────────────────────────────────────────────

export const coauthor_add: Flow<
  typeof coauthor_add_input,
  typeof coauthor_add_output
> = {
  name: "coauthor_add",
  description:
    "Add a Co-authored-by trailer to the PR branch via an empty commit. " +
    "Looks up the GitHub user by login to construct the canonical noreply email address. " +
    "Expected head SHA prevents committing to a stale branch. " +
    "Manages workspace lifecycle independently (clone → validate → empty commit → push → cleanup).",
  input: coauthor_add_input,
  output: coauthor_add_output,
  meta: {
    tags: ["git", "mutation", "repository_write", "coauthor"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:coauthor:${input.login}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof coauthor_add_input>,
  ): Promise<Static<typeof coauthor_add_output>> {
    const { prNumber, headSha, login } = input;

    // Step 1: Look up user to get numeric ID
    let user: { id: number; login: string };
    try {
      user = await ctx.github.getUserByLogin(login);
    } catch (err: unknown) {
      if (err instanceof Error && "status" in err && typeof err.status === "number" && err.status === 404) {
        throw new FlowError({
          code: "INVALID_INPUT",
          message: `GitHub user not found: ${login}`,
          publicMessage: `The GitHub user "${login}" was not found.`,
          retryable: false,
        });
      }
      throw new FlowError({
        code: "UPSTREAM_UNAVAILABLE",
        message: `Failed to look up GitHub user: ${(err as Error).message}`,
        publicMessage: `Could not verify GitHub user "${login}". The GitHub API may be unavailable.`,
        retryable: true,
      });
    }

    // Step 2: Acquire workspace, create empty commit, push
    let pr;
    try {
      pr = await ctx.github.getPullRequest(prNumber);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FlowError({
        code: "UPSTREAM_UNAVAILABLE",
        message: `Failed to fetch PR #${prNumber}: ${message}`,
        publicMessage: `Could not fetch PR #${prNumber}.`,
        retryable: true,
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
      if (actualSha !== headSha) {
        throw new FlowError({
          code: "STALE_HEAD",
          message: `Workspace HEAD is ${actualSha}, expected ${headSha}`,
          publicMessage: `PR #${prNumber} head changed before commit. Refresh and retry.`,
          retryable: false,
        });
      }

      // Construct noreply email: {id}+{login}@users.noreply.github.com
      const email = `${user.id}+${login}@users.noreply.github.com`;
      const trailer = `Co-authored-by: ${login} <${email}>`;
      const commitMsg = `Add co-author: ${login}`;

      // Create empty commit with trailer
      const proc = Bun.spawn(
        [
          "git",
          "-c", `user.name=${ctx.actor.login ?? "cfpa-bot"}`,
          "-c", `user.email=${ctx.actor.login ?? "cfpa-bot"}@users.noreply.github.com`,
          "commit", "--allow-empty",
          "-m", commitMsg,
          "--trailer", trailer,
        ],
        { cwd: tmpDir, stdout: "pipe", stderr: "pipe" },
      );

      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
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

      return { commitSha, identity: login };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      release();
    }
  },
};
