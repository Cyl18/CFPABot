// src/flows/files/files_sort_keys.ts
// Flow: files_sort_keys — sort JSON language file keys alphabetically.
// Risk: repository_write | Effects: git_commit, git_push
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §7.4
//
// Only accepts JSON language files (Record<string, string>).
// Non-string values are rejected — not silently dropped.
// Sorting uses ordinal (locale-aware) comparison.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import { sortJsonLangKeys } from "./_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const files_sort_keys_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  paths: Type.Array(Type.String(), {
    description: "JSON language file paths (relative to repo root)",
  }),
});

export type FilesSortKeysInput = Static<typeof files_sort_keys_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const files_sort_keys_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created commit" }),
  changedFiles: Type.Number({ description: "Number of files modified" }),
  totalKeys: Type.Number({ description: "Total keys across all changed files" }),
});

export type FilesSortKeysOutput = Static<typeof files_sort_keys_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const files_sort_keys: Flow<
  typeof files_sort_keys_input,
  typeof files_sort_keys_output
> = {
  name: "files_sort_keys",
  description:
    "Sort JSON language file keys alphabetically within a PR branch. " +
    "Only accepts JSON files with all-string values. Non-string values are rejected. " +
    "Files already in correct order are counted as unchanged. " +
    "Uses withPrWorkspace for isolated clone → validate → sort → diff → commit → push → cleanup.",
  input: files_sort_keys_input,
  output: files_sort_keys_output,
  meta: {
    tags: ["files", "mutation", "repository_write"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:sort_keys:${input.paths.join(",")}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_sort_keys_input>,
  ): Promise<Static<typeof files_sort_keys_output>> {
    const { prNumber, headSha, paths } = input;

    if (paths.length === 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: "At least one file path is required",
        publicMessage: "You must specify at least one language file path to sort.",
        retryable: false,
      });
    }

    const commitMessage = `Sort language file keys in ${paths.length} file(s)`;

    let changedFiles = 0;
    let totalKeys = 0;

    const result = await withPrWorkspace(
      ctx,
      {
        prNumber,
        expectedHeadSha: headSha,
        operationName: "files_sort_keys",
        commitMessage,
      },
      async (handle) => {
        for (const filePath of paths) {
          const result = await sortJsonLangKeys(handle, filePath);
          totalKeys += result.keyCount;
          changedFiles++;
        }
      },
    );

    if (result.skipped) {
      return { commitSha: "", changedFiles: 0, totalKeys: 0 };
    }

    return { commitSha: result.commitSha, changedFiles, totalKeys };
  },
};
