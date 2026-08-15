// src/flows/files/files_move_project.ts
// Flow: files_move_project — move an entire project directory within a PR branch.
// Risk: repository_write | Effects: git_commit, git_push
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §7.1

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import { collectMovedFiles } from "./_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const files_move_project_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  sourceProjectPath: Type.String({
    description: "Source project path (relative, e.g. projects/assets/foo/1.21)",
  }),
  targetProjectPath: Type.String({
    description: "Target project path (relative, must not exist)",
  }),
  commitMessage: Type.String({
    description: "Commit message describing the move",
  }),
});

export type FilesMoveProjectInput = Static<typeof files_move_project_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const files_move_project_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created commit" }),
  movedFiles: Type.Array(Type.String(), {
    description: "List of moved file paths (relative to repo root)",
  }),
});

export type FilesMoveProjectOutput = Static<typeof files_move_project_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const files_move_project: Flow<
  typeof files_move_project_input,
  typeof files_move_project_output
> = {
  name: "files_move_project",
  description:
    "Move an entire project directory (all language and metadata files) " +
    "from sourceProjectPath to targetProjectPath within a PR branch. " +
    "Target must not already exist unless source === target (idempotent skip). " +
    "Uses withPrWorkspace for isolated clone → validate → move → diff → commit → push → cleanup.",
  input: files_move_project_input,
  output: files_move_project_output,
  meta: {
    tags: ["files", "mutation", "repository_write"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:move_project:${input.sourceProjectPath}:${input.targetProjectPath}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_move_project_input>,
  ): Promise<Static<typeof files_move_project_output>> {
    const { prNumber, headSha, sourceProjectPath, targetProjectPath, commitMessage } = input;

    const result = await withPrWorkspace(
      ctx,
      {
        prNumber,
        expectedHeadSha: headSha,
        operationName: "files_move_project",
        commitMessage,
      },
      async (handle) => {
        const movedFiles = await collectMovedFiles(handle, sourceProjectPath, targetProjectPath, ctx.signal);

        // Store moved files on context state for return value construction
        ctx.state.set("files:move_project", "movedFiles", movedFiles);
      },
    );

    if (result.skipped) {
      return {
        commitSha: "",
        movedFiles: ctx.state.get<string[]>("files:move_project", "movedFiles") ?? [],
      };
    }

    return {
      commitSha: result.commitSha,
      movedFiles: ctx.state.get<string[]>("files:move_project", "movedFiles") ?? [],
    };
  },
};
