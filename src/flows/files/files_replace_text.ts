// src/flows/files/files_replace_text.ts
// Flow: files_replace_text — literal text search-and-replace in workspace files.
// Risk: repository_write | Effects: git_commit, git_push
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §7.3
//
// Restrictions:
// - Must specify explicit path list (no bare repo-wide replacement).
// - Literal search by default; regex only when useRegex=true.
// - Binary and unreadable files automatically skipped.
// - Replacement scope is bounded to the provided paths.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import {
  previewReplacements,
  applyTextReplacements,
} from "./_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const files_replace_text_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  paths: Type.Array(Type.String(), {
    description: "File paths to search (must be non-empty; each relative to repo root)",
    minItems: 1,
  }),
  search: Type.String({ description: "Literal search string" }),
  replace: Type.String({ description: "Replacement text" }),
  caseSensitive: Type.Optional(
    Type.Boolean({ description: "Case-sensitive match; default false" }),
  ),
  useRegex: Type.Optional(
    Type.Boolean({
      description:
        "Enable regex search instead of literal; default false." +
        " When true, 'search' is treated as a regex pattern. Complexity is not enforced — use with caution.",
    }),
  ),
  commitMessage: Type.Optional(
    Type.String({
      description:
        "Optional custom commit message; auto-generated if omitted",
    }),
  ),
});

export type FilesReplaceTextInput = Static<typeof files_replace_text_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const files_replace_text_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created commit" }),
  matchedFiles: Type.Number({ description: "Number of files with at least one match" }),
  totalReplacements: Type.Number({ description: "Total number of replacements made" }),
});

export type FilesReplaceTextOutput = Static<typeof files_replace_text_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const files_replace_text: Flow<
  typeof files_replace_text_input,
  typeof files_replace_text_output
> = {
  name: "files_replace_text",
  description:
    "Literal (or regex) search-and-replace across a bounded set of file paths " +
    "in a PR branch. Preview is logged before applying. " +
    "No bare repo-wide replacement: paths must be explicitly provided. " +
    "Uses withPrWorkspace for isolated clone → validate → replace → diff → commit → push → cleanup.",
  input: files_replace_text_input,
  output: files_replace_text_output,
  meta: {
    tags: ["files", "mutation", "repository_write"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:replace_text:${input.search}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_replace_text_input>,
  ): Promise<Static<typeof files_replace_text_output>> {
    const {
      prNumber,
      headSha,
      paths,
      search,
      replace,
      caseSensitive = false,
      useRegex = false,
    } = input;

    // At this point path restriction is enforced by the schema (minItems: 1).
    // The Flow itself refuses to run with no paths as defence-in-depth.
    if (paths.length === 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: "At least one file path is required for text replacement",
        publicMessage: "You must specify at least one file path for text replacement.",
        retryable: false,
      });
    }

    const commitMessage =
      input.commitMessage ?? `Replace text in ${paths.length} file(s): "${search}"`;

    let matchedFiles = 0;
    let totalReplacements = 0;

    const result = await withPrWorkspace(
      ctx,
      {
        prNumber,
        expectedHeadSha: headSha,
        operationName: "files_replace_text",
        commitMessage,
      },
      async (handle) => {
        // Log preview before applying
        const preview = await previewReplacements(
          handle,
          paths,
          search,
          replace,
          caseSensitive,
        );
        ctx.logger.info(
          { operationName: "files_replace_text", preview },
          `Text replacement preview: ${preview.length} file(s) will be modified`,
        );

        // Apply replacements
        const applied = await applyTextReplacements(
          handle,
          paths,
          search,
          replace,
          caseSensitive,
        );

        matchedFiles = applied.length;
        totalReplacements = applied.reduce((sum, r) => sum + r.replacementCount, 0);
      },
    );

    if (result.skipped) {
      return { commitSha: "", matchedFiles: 0, totalReplacements: 0 };
    }

    return { commitSha: result.commitSha, matchedFiles, totalReplacements };
  },
};
