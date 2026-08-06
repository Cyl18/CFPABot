// src/flows/git/git_revert_commit.ts
// Flow: git_revert_commit — revert a specific commit in a PR branch.
// Risk: destructive | Effects: git_commit, git_push
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §8.1
//
// Uses `git revert` to create a new commit that undoes the target.
// Never uses reset or force push. Conflicts prevent push and return
// conflict file list for manual resolution.
//
// DESTRUCTIVE — requires agent invocation source.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { revertCommitInWorkspace } from "./_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const git_revert_commit_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  targetCommitSha: Type.String({
    description: "SHA of the commit to revert (must be reachable from PR HEAD)",
  }),
});

export type GitRevertCommitInput = Static<typeof git_revert_commit_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const git_revert_commit_output = Type.Object({
  revertCommitSha: Type.String({
    description: "SHA of the revert commit (empty string if conflict)",
  }),
  conflictFiles: Type.Optional(
    Type.Array(Type.String(), {
      description: "List of conflicted files; present only when conflicts occur",
    }),
  ),
  revertedSha: Type.String({
    description: "SHA of the commit that was reverted",
  }),
});

export type GitRevertCommitOutput = Static<typeof git_revert_commit_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const git_revert_commit: Flow<
  typeof git_revert_commit_input,
  typeof git_revert_commit_output
> = {
  name: "git_revert_commit",
  description:
    "Revert a specific commit in a PR branch using git revert. " +
    "The target commit must be reachable from PR HEAD. " +
    "On conflict, no push occurs — returns the list of conflicted files " +
    "for manual resolution. " +
    "Expected head SHA protects against stale branch state. " +
    "No force push, no reset. DESTRUCTIVE risk — requires agent invocation.",
  input: git_revert_commit_input,
  output: git_revert_commit_output,
  meta: {
    tags: ["git", "destructive", "repository_write"],
    risk: "destructive",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 180_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:revert:${input.targetCommitSha}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof git_revert_commit_input>,
  ): Promise<Static<typeof git_revert_commit_output>> {
    const { prNumber, headSha, targetCommitSha } = input;

    if (targetCommitSha === headSha) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: "Cannot revert the PR HEAD commit itself",
        publicMessage: "You cannot revert the most recent commit of the PR. Reverting HEAD would change the diff base in unexpected ways.",
        retryable: false,
      });
    }

    const result = await revertCommitInWorkspace(
      ctx,
      prNumber,
      headSha,
      targetCommitSha,
    );

    return {
      revertCommitSha: result.revertCommitSha,
      conflictFiles: result.conflictFiles,
      revertedSha: targetCommitSha,
    };
  },
};
