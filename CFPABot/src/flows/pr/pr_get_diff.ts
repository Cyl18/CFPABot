// src/flows/pr/pr_get_diff.ts
// Flow: pr_get_diff — paginated PR diff with opaque string cursor, size limits,
// and file-level stats. Cursor encoding is stable: base64url(JSON {v,p}).
// Risk: read | Effects: github_read
// Uses loadPrDiff() internal helper for diff loading and size enforcement.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { loadPrDiff } from "../_internal/index.js";

// ─── Cursor encoding ───────────────────────────────────────────────────
// Opaque string cursor: base64url-encoded JSON { v:"1", p:<pageStartIndex> }.
// Stable across sessions — no hashing, no random component.

const CURSOR_VERSION = "1";

interface CursorData {
  v: string;
  p: number;
}

export function encodeCursor(pageStart: number): string {
  const data: CursorData = { v: CURSOR_VERSION, p: pageStart };
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function decodeCursor(raw: string): number {
  let data: CursorData;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    data = JSON.parse(json) as CursorData;
  } catch {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Invalid cursor format: "${raw}"`,
      publicMessage: "游标格式无效",
      retryable: false,
    });
  }
  if (data.v !== CURSOR_VERSION) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Unknown cursor version: "${data.v}"`,
      publicMessage: "游标版本不兼容",
      retryable: false,
    });
  }
  if (!Number.isInteger(data.p) || data.p < 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Invalid cursor offset: ${data.p}`,
      publicMessage: "游标偏移量无效",
      retryable: false,
    });
  }
  return data.p;
}

// ─── Input Schema ──────────────────────────────────────────────────────

export const pr_get_diff_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA — fails STALE_HEAD if mismatch" }),
  cursor: Type.Optional(
    Type.String({ description: "Opaque cursor from previous response. Omit or null for first page." }),
  ),
  pathPrefix: Type.Optional(
    Type.String({ description: "Filter to files starting with this path prefix. Rejects .. traversal." }),
  ),
  maxFiles: Type.Optional(
    Type.Number({ description: "Max files per page (default 50, max 200). Must be positive finite." }),
  ),
  maxBytes: Type.Optional(
    Type.Number({ description: "Max raw diff bytes before truncation (default 1MB). Must be positive finite." }),
  ),
});

export type PrGetDiffInput = Static<typeof pr_get_diff_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const pr_get_diff_output = Type.Object({
  headSha: Type.String({ description: "The head SHA the diff was produced from" }),
  files: Type.Array(
    Type.Object({
      filename: Type.String(),
      status: Type.String(),
      additions: Type.Number(),
      deletions: Type.Number(),
      changes: Type.Number(),
      patch: Type.Optional(Type.String()),
    }),
  ),
  rawDiff: Type.Optional(Type.String({ description: "Unified diff text, truncated if over maxBytes" })),
  truncated: Type.Boolean({ description: "True if rawDiff was truncated due to size limits" }),
  hasMore: Type.Boolean({ description: "True when there are more pages beyond this one" }),
  nextCursor: Type.Union([Type.String(), Type.Null()], {
    description: "Opaque cursor for the next page. Null when hasMore is false.",
  }),
  returnedFiles: Type.Number({ description: "Number of files in this response" }),
});

export type PrGetDiffOutput = Static<typeof pr_get_diff_output>;

// ─── Path prefix safety ────────────────────────────────────────────────

function normalizePathPrefix(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.includes("..")) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `pathPrefix contains .. traversal: "${raw}"`,
      publicMessage: "路径前缀不能包含 ..",
      retryable: false,
    });
  }
  return normalized;
}

// ─── Flow Definition ────────────────────────────────────────────────────

export const pr_get_diff: Flow<typeof pr_get_diff_input, typeof pr_get_diff_output> = {
  name: "pr_get_diff",
  description: "Load the PR diff for a fixed head SHA with pagination (opaque string cursor), file-level stats, and optional path prefix filtering. Returns the unified diff truncated at maxBytes. Invariant: results always correspond to the specified headSha, not the current head.",
  input: pr_get_diff_input,
  output: pr_get_diff_output,
  meta: {
    tags: ["pr", "query", "review"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_get_diff_input>): Promise<Static<typeof pr_get_diff_output>> {
    // ── Parse & validate inputs ──────────────────────────────────────
    const {
      prNumber,
      headSha,
      cursor,
      pathPrefix,
      maxFiles = 50,
      maxBytes = 1_048_576,
    } = input;

    if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `maxFiles must be positive finite, got ${maxFiles}`,
        publicMessage: "文件数上限必须为正数",
        retryable: false,
      });
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `maxBytes must be positive finite, got ${maxBytes}`,
        publicMessage: "字节上限必须为正数",
        retryable: false,
      });
    }

    const cappedPageSize = Math.min(Math.floor(maxFiles), 200);
    const pageStart = cursor ? decodeCursor(cursor) : 0;

    // ── Load PR diff ─────────────────────────────────────────────────
    // We request a generous number of files from loadPrDiff so that
    // cursor-based pagination works correctly even with pathPrefix filtering.
    // loadPrDiff's maxFiles is purely a safety cap, not a page-size signal.
    const loadLimit = Math.max(1000, pageStart + cappedPageSize + 100);
    const prDiff = await loadPrDiff(ctx, {
      prNumber,
      expectedHeadSha: headSha,
      maxFiles: loadLimit,
      maxBytes,
    });

    // ── Apply path prefix filter ─────────────────────────────────────
    let filteredFiles = prDiff.files;
    if (pathPrefix) {
      const safePrefix = normalizePathPrefix(pathPrefix);
      filteredFiles = prDiff.files.filter((f) =>
        f.filename.startsWith(safePrefix),
      );
    }

    // ── Slice to requested page ──────────────────────────────────────
    const pageFiles = filteredFiles.slice(pageStart, pageStart + cappedPageSize);
    const hasMore = pageStart + pageFiles.length < filteredFiles.length;
    const nextCursor = hasMore ? encodeCursor(pageStart + pageFiles.length) : null;

    return {
      headSha: prDiff.headSha,
      files: pageFiles.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        ...(f.patch ? { patch: f.patch } : {}),
      })),
      rawDiff: prDiff.rawDiff,
      truncated: prDiff.truncated,
      hasMore,
      nextCursor,
      returnedFiles: pageFiles.length,
    };
  },
};
