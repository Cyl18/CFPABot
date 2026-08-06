// src/flows/_internal/types.ts
// Business DTOs for _internal helpers. These are NOT Flow types —
// they are normalized data contracts between cross-domain internal operations.

// FlowError lives in src/types.ts — do not duplicate. Import canonical class:
export { FlowError } from "../../types.js";
export type { FlowErrorCode } from "../../types.js";

import { FlowError } from "../../types.js";
 import type { LangFileParseError } from "../_shared/types.js";
// ──────────────────────────────────────────
// PR Snapshot
// ──────────────────────────────────────────

export interface PrSnapshot {
  prNumber: number;
  title: string;
  htmlUrl: string;
  state: "open" | "closed";
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  author: { login: string; id: number } | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────
// PR Diff
// ──────────────────────────────────────────

export type DiffFileStatus = "added" | "modified" | "removed" | "renamed";

export interface DiffFile {
  filename: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff patch text (may be absent for large/binary files). */
  patch?: string;
  /** Previous filename for renamed files (DiffFileStatus "renamed"). */
  previousFilename?: string;
}

export interface LoadPrDiffOptions {
  prNumber: number;
  expectedHeadSha?: string;
  maxFiles?: number;
  maxBytes?: number;
}

export interface PrDiff {
  headSha: string;
  files: DiffFile[];
  rawDiff?: string;
  truncated: boolean;
}

// ──────────────────────────────────────────
// File at Ref
// ──────────────────────────────────────────

export interface FileAtRef {
  path: string;
  ref: string;
  /** Text content (decoded). Null only when the file does not exist. */
  content: string | null;
  /** Size in bytes (from API). 0 for non-existent files. */
  size: number;
}

export interface LoadFileAtRefOptions {
  path: string;
  ref: string;
  /** Max content size in bytes (default 1 MiB). Throws if exceeded. */
  maxBytes?: number;
}

// ──────────────────────────────────────────
// Language Pairs
// ──────────────────────────────────────────

export interface ParsedLangFile {
  entries: Record<string, string>;
  errors: LangFileParseError[];
}

export interface LanguageFilePair {
  /** Mod identity (slug + version + domain). */
  modPath: { slug: string; gameVersion: string; modDomain: string };
  format: "json" | "lang";
  /** The canonical changed path (preserves old/new format) used to derive siblings. */
  canonicalPath: string;
  base: { enUs?: ParsedLangFile; zhCn?: ParsedLangFile };
  head: { enUs?: ParsedLangFile; zhCn?: ParsedLangFile };
}

export interface LanguagePairError {
  modPath?: { slug: string; gameVersion: string; modDomain: string };
  filePath?: string;
  ref?: string;
  message: string;
}

export interface CollectLanguagePairsResult {
  pairs: LanguageFilePair[];
  errors: LanguagePairError[];
}

// ──────────────────────────────────────────
// Workspace
// ──────────────────────────────────────────

export interface WorkspaceOptions {
  prNumber: number;
  expectedHeadSha: string;
  /** Human label for logging/lock identification (not the git commit text). */
  operationName: string;
  /** Explicit commit message to use. Must be non-empty after validation. */
  commitMessage: string;
}

export interface WorkspaceHandle {
  /** Absolute path to the local clone working directory. */
  dir: string;
}

export interface WorkspaceCommitResult {
  skipped: false;
  commitSha: string;
}

export interface WorkspaceSkippedResult {
  skipped: true;
}

export type WorkspaceMutateResult = WorkspaceCommitResult | WorkspaceSkippedResult;

// ──────────────────────────────────────────
// Cross-domain error / status helpers
// ──────────────────────────────────────────

/**
 * Normalize GitHub file status strings to our DiffFileStatus union.
 * Unknown statuses default to "modified".
 */
export function normalizeDiffFileStatus(status: string): DiffFileStatus {
  switch (status) {
    case "added":
      return "added";
    case "modified":
      return "modified";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * Map common GitHubClient errors to FlowError.
 * Non-retryable by default; retryable only for rate-limit / unavailable.
 */
export function wrapClientError(err: unknown, fallbackMessage: string): FlowError {
  const message = err instanceof Error ? err.message : String(err);
  const isRateLimit = /rate\s*limit/i.test(message) || /403/i.test(message);
  const isUnavailable = /5\d\d/i.test(message) || /unavailable/i.test(message);

  return new FlowError({
    code: isRateLimit ? "UPSTREAM_RATE_LIMITED" : isUnavailable ? "UPSTREAM_UNAVAILABLE" : "FAILED",
    message,
    publicMessage: fallbackMessage,
    retryable: isRateLimit || isUnavailable,
    details: { originalError: message },
  });
}
