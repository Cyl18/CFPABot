// src/flows/pr/pr_read_file.ts
// Flow: pr_read_file — read a file from the repo at a specific ref (commit SHA),
// with path safety validation, binary detection, and size limits.
// Risk: read | Effects: github_read
// Uses loadFileAtRef() internal helper.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { loadFileAtRef } from "../_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const pr_read_file_input = Type.Object({
  prNumber: Type.Number({ description: "PR number (for scope validation)" }),
  ref: Type.Union(
    [Type.Literal("base"), Type.Literal("head")],
    { description: "Which side of the PR to read from" },
  ),
  sha: Type.String({ description: "Explicit commit SHA for the ref" }),
  path: Type.String({ description: "File path relative to repo root" }),
  maxBytes: Type.Optional(
    Type.Number({ description: "Max content bytes (default 1 MiB)" }),
  ),
});

export type PrReadFileInput = Static<typeof pr_read_file_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const pr_read_file_output = Type.Object({
  path: Type.String(),
  sha: Type.String({ description: "Blob SHA for cache/etag" }),
  content: Type.Union([Type.String(), Type.Null()], {
    description: "Text content (null for binary, non-existent, or oversized)",
  }),
  encoding: Type.String({ description: "Content encoding (\"utf-8\" or \"binary\")" }),
  truncated: Type.Boolean({ description: "True if content was truncated due to maxBytes" }),
  binary: Type.Boolean({ description: "True if the file appears to be binary" }),
  size: Type.Number({ description: "File size in bytes (may be 0 if non-existent)" }),
  exists: Type.Boolean({ description: "False if file does not exist at this ref" }),
});

export type PrReadFileOutput = Static<typeof pr_read_file_output>;

// ─── Validation ────────────────────────────────────────────────────────

/** Rough binary detection by checking for null bytes in the first 8 KiB. */
function isLikelyBinary(content: string): boolean {
  const sample = content.slice(0, 8192);
  return sample.includes("\0");
}

// ─── Flow Definition ────────────────────────────────────────────────────

export const pr_read_file: Flow<typeof pr_read_file_input, typeof pr_read_file_output> = {
  name: "pr_read_file",
  description: "Read a file from the repo at a specific commit SHA (not a branch/tag). Validates path safety (rejects absolute paths and .. traversal). Reports binary, oversized, and missing files explicitly.",
  input: pr_read_file_input,
  output: pr_read_file_output,
  meta: {
    tags: ["pr", "query"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_read_file_input>): Promise<Static<typeof pr_read_file_output>> {
    const { prNumber, ref, sha, path, maxBytes } = input;

    // Path safety: reject absolute paths and directory traversal
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("/")) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Absolute paths are not allowed: "${path}"`,
        publicMessage: `路径不合法：不能使用绝对路径`,
        retryable: false,
      });
    }
    if (normalized.includes("..")) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Directory traversal is not allowed: "${path}"`,
        publicMessage: `路径不合法：不能包含 ".."`,
        retryable: false,
      });
    }

    // Load the file via the internal helper (SHA-only for security)
    const file = await loadFileAtRef(ctx, {
      path: normalized,
      ref: sha,
      maxBytes,
    });

    if (file.content === null) {
      return {
        path: normalized,
        sha,
        content: null,
        encoding: "utf-8",
        truncated: false,
        binary: false,
        size: file.size,
        exists: false,
      };
    }

    const binary = isLikelyBinary(file.content);
    if (binary) {
      return {
        path: normalized,
        sha,
        content: null,
        encoding: "binary",
        truncated: false,
        binary: true,
        size: file.size,
        exists: true,
      };
    }

    return {
      path: normalized,
      sha,
      content: file.content,
      encoding: "utf-8",
      truncated: maxBytes !== undefined && file.size > maxBytes,
      binary: false,
      size: file.size,
      exists: true,
    };
  },
};
