// src/flows/_shared/types.ts
// Domain types for the _shared pure layer.
// These types describe data processed by pure helpers and are NOT registered
// in the Flow type system (no Flow, FlowContext, etc.).

// ──────────────────────────────────────────
// Diff Row (core type, defined locally since it lives in the pure layer)
// ──────────────────────────────────────────

/** A row in a translation diff comparison table. */
export interface DiffRow {
  key: string;
  oldEnglish: string;
  newEnglish: string;
  oldChinese: string;
  newChinese: string;
  status: "new" | "modified" | "removed" | "unchanged";
  termCheck: "ok" | "warning" | "error";
}
// ──────────────────────────────────────────
// Mod / Project Paths
// ──────────────────────────────────────────

/** Result of parsing a Minecraft mod language file project path. */
export interface ModProjectPath {
  /** Mod slug (e.g. "twilightforest") */
  slug: string;
  /** Game version directory (e.g. "1.21.1") */
  gameVersion: string;
  /** Mod domain (e.g. "twilightforest") */
  modDomain: string;
  /** Language file name (e.g. "zh_cn.json", "en_us.lang") */
  fileName: string;
  /** True for old-format paths: projects/{version}/{slug}/{domain}/lang/{file} */
  isOldFormat: boolean;
}

/** A changed file with its parsed ModProjectPath. */
export interface ModPathEntry {
  rawPath: string;
  parsed: ModProjectPath;
}

/** Unique mod identity within a change set. */
export interface ModIdentity {
  slug: string;
  gameVersion: string;
  modDomain: string;
}

// ──────────────────────────────────────────
// Language Files
// ──────────────────────────────────────────

export type LanguageFileFormat = "json" | "lang";

export interface LangFileParseError {
  line?: number;
  message: string;
}

export interface LangFileParseResult {
  entries: Record<string, string>;
  errors: LangFileParseError[];
}


// ──────────────────────────────────────────
// Diff
// ──────────────────────────────────────────

export interface LangDiffStats {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}

export interface LangDiffResult {
  rows: DiffRow[];
  stats: LangDiffStats;
}

// ──────────────────────────────────────────
// Terminology
// ──────────────────────────────────────────

export interface TermRule {
  id: string;
  /** Substring or regex pattern to match in the Chinese translation. */
  pattern: string;
  level: "warning" | "error";
  /** Human-readable message describing the issue. */
  message: string;
  /** Version constraints (Minecraft version). */
  versions?: {
    include?: string[];
    exclude?: string[];
    min?: string;
  };
  /** Translation values that are exceptions and should NOT trigger the rule. */
  exceptions?: string[];
}

export interface MatchedTerm {
  ruleId: string;
  key: string;
  value: string;
  level: "warning" | "error";
  message: string;
}

// ──────────────────────────────────────────
// Deterministic Checks (Finding)
// ──────────────────────────────────────────

export interface Finding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  line?: number;
  evidence?: string;
  suggestedLabel?: string;
}

// ──────────────────────────────────────────
// Review
// ──────────────────────────────────────────

export type ReviewCategory =
  | "correctness"
  | "translation"
  | "terminology"
  | "security"
  | "performance"
  | "maintainability";

export type Severity = "info" | "warning" | "error";

export type Side = "LEFT" | "RIGHT";

export interface ReviewFinding {
  fingerprint: string;
  category: ReviewCategory;
  severity: Severity;
  title: string;
  explanation: string;
  evidence: string;
  path?: string;
  line?: number;
  side?: Side;
  suggestion?: string;
}

export interface ReviewDraft {
  prNumber: number;
  headSha: string;
  kind: "code" | "translation" | "mixed";
  summary: string;
  findings: ReviewFinding[];
}
// ──────────────────────────────────────────
// Info Comment State
// ──────────────────────────────────────────

export interface PublicError {
  code: string;
  publicMessage: string;
  retryable: boolean;
  cause?: unknown;
}

export type SectionState<T> =
  | { status: "pending" }
  | { status: "ready"; data: T; inputHash: string; updatedAt: string }
  | { status: "empty"; inputHash: string; updatedAt: string }
  | { status: "error"; error: PublicError; inputHash: string; updatedAt: string };

/**
 * Collector return type — like SectionState but without updatedAt (the state
 * layer assigns that when persisting). Collectors return this to the refresh
 * internal operation.
 */
export type SectionResult<T> =
  | { status: "ready"; data: T; inputHash: string }
  | { status: "empty"; inputHash: string }
  | { status: "error"; error: PublicError; inputHash: string };

export interface ModLinkEntry {
  provider: "curseforge" | "modrinth";
  slug: string;
  projectId?: string;
  name: string;
  iconUrl?: string;
  projectUrl: string;
  sourceUrl?: string;
  gameVersions: string[];
  domains: string[];
  dependencies: ModDependency[];
}

export interface ModDependency {
  name: string;
  relation: "required" | "optional" | "embedded";
}

export interface ModLinksData {
  mods: ModLinkEntry[];
  truncated: boolean;
  errors: PublicError[];
}

export interface ArtifactsData {
  state:
    | "branch_not_supported"
    | "maintainer_edits_disabled"
    | "waiting"
    | "approval_required"
    | "running"
    | "completed"
    | "no_artifacts"
    | "pr_closed"
    | "failed";
  workflowRunId?: number;
  artifacts?: Array<{ name: string; downloadUrl: string; expiresAt?: string }>;
  message?: string;
}

export interface ChecksData {
  findings: Finding[];
}

export interface TranslationDiffSummary {
  pairCount: number;
  modifiedCount: number;
  addedCount: number;
  removedCount: number;
  compareUrl?: string;
}

export interface InfoCommentSectionStates {
  mods: SectionState<ModLinksData>;
  artifacts: SectionState<ArtifactsData>;
  checks: SectionState<ChecksData>;
  translationDiff: SectionState<TranslationDiffSummary>;
}

export interface InfoCommentState {
  schemaVersion: 1;
  revision: number;
  repo: string;
  prNumber: number;
  commentId?: number;
  headSha: string;
  updatedAt: string;
  sections: InfoCommentSectionStates;
}

// ──────────────────────────────────────────
// Re-export DiffRow for convenience
// ──────────────────────────────────────────

