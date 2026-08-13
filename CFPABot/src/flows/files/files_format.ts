// src/flows/files/files_format.ts
// Flow: files_format — format language files to project conventions.
// Risk: repository_write | Effects: git_commit, git_push
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §7.5
//
// JSON: 4-space indent, \n line endings, trailing newline, string-only values.
// .lang: preserve comments, collapse consecutive blank lines to one, trailing newline.
// Uses formatLanguage() from _shared pure layer.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import { formatLangFiles } from "./_internal/index.js";
import type { LanguageFileFormat } from "../_shared/types.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const files_format_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  paths: Type.Array(Type.String(), {
    description: "Language file paths to format (relative to repo root)",
  }),
  format: Type.Optional(
    Type.Union([Type.Literal("json"), Type.Literal("lang")], {
      description: "Force format type; auto-detected from extension by default",
    }),
  ),
});

export type FilesFormatInput = Static<typeof files_format_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const files_format_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created commit" }),
  formatted: Type.Number({ description: "Number of files formatted" }),
  skipped: Type.Number({ description: "Number of files already correctly formatted" }),
  failed: Type.Number({ description: "Number of files that could not be formatted" }),
});

export type FilesFormatOutput = Static<typeof files_format_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const files_format: Flow<
  typeof files_format_input,
  typeof files_format_output
> = {
  name: "files_format",
  description:
    "Format language files (JSON or .lang) to project conventions within a PR branch. " +
    "JSON: 4-space indent, sorted keys, Unix newlines, trailing newline, string-only validation. " +
    ".lang: preserve comments, single blank line between blocks, trailing newline. " +
    "Uses withPrWorkspace for isolated clone → validate → format → diff → commit → push → cleanup.",
  input: files_format_input,
  output: files_format_output,
  meta: {
    tags: ["files", "mutation", "repository_write"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:format:${input.paths.join(",")}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_format_input>,
  ): Promise<Static<typeof files_format_output>> {
    const { prNumber, headSha, paths } = input;

    if (paths.length === 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: "At least one file path is required",
        publicMessage: "You must specify at least one language file path to format.",
        retryable: false,
      });
    }

    const explicitFormat = input.format as LanguageFileFormat | undefined;
    const commitMessage = `Format ${paths.length} language file(s)`;

    let formatted = 0;
    let skipped = 0;
    let failed = 0;

    const result = await withPrWorkspace(
      ctx,
      {
        prNumber,
        expectedHeadSha: headSha,
        operationName: "files_format",
        commitMessage,
      },
      async (handle) => {
        const output = await formatLangFiles(handle, paths, explicitFormat);
        formatted = output.results.filter((r) => r.formatted).length;
        skipped = output.skipped;
        failed = output.failed;
      },
    );

    if (result.skipped) {
      return { commitSha: "", formatted: 0, skipped, failed: 0 };
    }

    return { commitSha: result.commitSha, formatted, skipped, failed };
  },
};
