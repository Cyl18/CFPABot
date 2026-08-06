// src/runtime-paths.ts
// Single source of truth for runtime on-disk layout. Every writer/reader under
// `runtime/` imports its path roots/helpers from here — no other module may
// hardcode a `runtime/...` string.
//
// Layout (see also AGENTS.md "运行时目录"):
//
// runtime/
// ├── cache/                       # rebuildable only
// │   ├── modlist.json
// │   ├── curseforge-mapping.json
// │   ├── pr_index.json
// │   ├── pr_files/                # was runtime/pr_cache/*.json
// │   │   └── {prId}.json
// │   └── pr_files_watermark.json
// ├── state/                       # durable business state
// │   └── info-comments/           # was runtime/cache/info-comments
// │       └── {owner}/{repo}/{pr}.json
// ├── sessions/                    # Agent session JSON (+ meta)
// │   ├── {uuid}.json
// │   ├── _dedup/
// │   └── transcripts/             # was runtime/pi-sessions
// │       └── {ts}_{id}.jsonl
// ├── ops/
// │   ├── executions/              # was runtime/executions
// │   └── idempotency/             # was runtime/idempotency
// └── repo/                        # shallow clone — stay top-level

import crypto from "node:crypto";

// ─── Cache (rebuildable) ──────────────────────────────────────────────

export const CACHE_DIR = "runtime/cache";
export const MODLIST_PATH = `${CACHE_DIR}/modlist.json`;
export const MAPPING_PATH = `${CACHE_DIR}/curseforge-mapping.json`;
export const PR_INDEX_PATH = `${CACHE_DIR}/pr_index.json`;
export const PR_FILES_DIR = `${CACHE_DIR}/pr_files`;
export const PR_FILES_WATERMARK_PATH = `${CACHE_DIR}/pr_files_watermark.json`;
export const TM_DIR = `${CACHE_DIR}/tm`;

// ─── State (durable business state) ───────────────────────────────────

export const STATE_DIR = "runtime/state";
export const INFO_COMMENTS_DIR = `${STATE_DIR}/info-comments`;

// ─── Sessions ─────────────────────────────────────────────────────────

export const SESSIONS_DIR = "runtime/sessions";
export const SESSIONS_DEDUP_DIR = `${SESSIONS_DIR}/_dedup`;
export const SESSIONS_TRANSCRIPTS_DIR = `${SESSIONS_DIR}/transcripts`;
export const SESSIONS_CTX_DIR = `${SESSIONS_DIR}/ctx`;

// ─── Ops ──────────────────────────────────────────────────────────────

export const OPS_DIR = "runtime/ops";
export const EXECUTIONS_DIR = `${OPS_DIR}/executions`;
export const IDEMPOTENCY_DIR = `${OPS_DIR}/idempotency`;

// ─── Repo (shallow clone) ────────────────────────────────────────────

export const REPO_DIR = "runtime/repo";

// ─── Pi agent dir (extension/settings host for pi-coding-agent SDK) ──

export const AGENT_DIR = "runtime/agent";
export const AGENT_SETTINGS_PATH = `${AGENT_DIR}/settings.json`;

// ─── Required directories (created by ensureDirectories at boot) ──────

export const REQUIRED_DIRS = [
  "config",
  "runtime/cache/pr_files",
  "runtime/cache/tm",
  "runtime/state/info-comments",
  "runtime/sessions/transcripts",
  "runtime/sessions/_dedup",
  "runtime/sessions/ctx",
  "runtime/ops/executions",
  "runtime/ops/idempotency",
  "logs",
  "temp",
  "runtime/repo",
  AGENT_DIR,
] as const;

// ─── Path helpers ─────────────────────────────────────────────────────


export function prFilePath(prId: number): string {
  return `${PR_FILES_DIR}/${prId}.json`;
}

/** Per-slug translation-memory index path (written by tm_build, read by tm_query). */
export function tmIndexPath(slug: string): string {
  return `${TM_DIR}/${slug}.json`;
}

export function sessionPath(sessionId: string): string {
  return `${SESSIONS_DIR}/${sessionId}.json`;
}

export function sessionTranscriptPath(fileName: string): string {
  return `${SESSIONS_TRANSCRIPTS_DIR}/${fileName}`;
}

/** Per-session ctx snapshot path (incremental persistence of session ctx). */
export function sessionCtxPath(sessionId: string): string {
  return `${SESSIONS_CTX_DIR}/${sessionId}.json`;
}

export function dedupPath(hex: string): string {
  return `${SESSIONS_DEDUP_DIR}/${hex}.json`;
}

export function idempotencyPath(key: string): string {
  const hex = crypto.createHash("sha256").update(key, "utf-8").digest("hex");
  return `${IDEMPOTENCY_DIR}/${hex}.json`;
}

export function executionPath(id: string): string {
  return `${EXECUTIONS_DIR}/${id}.ndjson`;
}

/** Absolute path for the shallow-clone repo dir, resolved from cwd. */
export function repoDirAbs(): string {
  return `${process.cwd().replace(/\\/g, "/")}/${REPO_DIR}`;
}
