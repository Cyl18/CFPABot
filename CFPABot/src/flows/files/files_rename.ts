// src/flows/files/files_rename.ts
// Flow: files_rename — rename a single file within a PR branch.
// Risk: repository_write | Effects: git_commit, git_push
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §7.2

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import { safeRename } from "./_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const files_rename_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  sourcePath: Type.String({
    description: "Source file path (relative to repo root)",
  }),
  targetPath: Type.String({
    description: "Target file path (relative to repo root, must not exist)",
  }),
});

export type FilesRenameInput = Static<typeof files_rename_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const files_rename_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created commit" }),
  finalPath: Type.String({ description: "Final path after rename" }),
});

export type FilesRenameOutput = Static<typeof files_rename_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const files_rename: Flow<
  typeof files_rename_input,
  typeof files_rename_output
> = {
  name: "files_rename",
  description:
    "Rename a single file within a PR branch. " +
    "Handles case-only renames safely via two-step rename (temp intermediate) " +
    "for cross-platform filesystem compatibility. " +
    "Target must not already exist. " +
    "Uses withPrWorkspace for isolated clone → validate → rename → diff → commit → push → cleanup.",
  input: files_rename_input,
  output: files_rename_output,
  meta: {
    tags: ["files", "mutation", "repository_write"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:rename:${input.sourcePath}:${input.targetPath}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_rename_input>,
  ): Promise<Static<typeof files_rename_output>> {
    const { prNumber, headSha, sourcePath, targetPath } = input;
    const commitMessage = `Rename ${sourcePath} → ${targetPath}`;

    let finalPath = targetPath;

    const result = await withPrWorkspace(
      ctx,
      {
        prNumber,
        expectedHeadSha: headSha,
        operationName: "files_rename",
        commitMessage,
      },
      async (handle) => {
        finalPath = await safeRename(handle, sourcePath, targetPath);
      },
    );

    if (result.skipped) {
      return { commitSha: "", finalPath };
    }

    return { commitSha: result.commitSha, finalPath };
  },
};
