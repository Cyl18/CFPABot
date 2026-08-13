// src/types.ts
// Architecture types: Flow, FlowContext, FlowRisk, FlowEffect, FlowError, ExecutionRecord.
// Domain types (GitHubClient, PullRequest, etc.) live in client/github/types.ts.

import type { GitHubClient } from "./client/github/index.js";
import type { TSchema, Static } from "typebox";
import type { EntryConfig } from "./config.js";

// ─── Risk & effects ───────────────────────────────────────────────────

export type FlowRisk =
  | "read"
  | "review_write"
  | "repository_write"
  | "destructive";

export type FlowEffect =
  | "github_read"
  | "github_comment_write"
  | "github_metadata_write"
  | "github_check_write"
  | "github_workflow_write"
  | "git_commit"
  | "git_push"
  | "storage_write"
  | "external_write";

// ─── Flow ─────────────────────────────────────────────────────────────

export interface Flow<
  InputSchema extends TSchema = TSchema,
  OutputSchema extends TSchema = TSchema,
> {
  name: string;
  description: string;
  input: InputSchema;
  output: OutputSchema;
  meta: {
    tags: readonly string[];
    risk: FlowRisk;
    effects: readonly FlowEffect[];
    timeoutMs?: number;
    retry?: { maxAttempts: number; backoffMs: number };
    idempotencyKey?: (
      invocation: InvocationMeta,
      input: Static<InputSchema>,
    ) => string;
    agent_callable?: boolean;
  };
  execute(
    ctx: FlowContext,
    input: Static<InputSchema>,
  ): Promise<Static<OutputSchema>>;
}

// ─── Invocation metadata (lightweight, used by idempotencyKey) ────────

export interface InvocationMeta {
  readonly source: "agent" | "webhook" | "api" | "cron";
  readonly id: string;
  readonly deliveryId?: string;
  readonly sessionId?: string;
}

// ─── FlowContext ──────────────────────────────────────────────────────

export interface FlowContext {
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  actor: {
    kind: "admin" | "system";
    login?: string;
  };
  scope: {
    prNumber?: number;
    baseSha?: string;
    headSha?: string;
  };
  invocation: InvocationMeta & {
    parentId?: string;
  };
  github: GitHubClient;
  store: FileStore;
  logger: Logger;
  config: EntryConfig;
  state: ScopedState;
  /** Caller-owned per-invocation cancellation. Webhook callers must use a
   *  detached (never-aborted) signal. executeFlow derives its own timeout
   *  by combining this signal with a local AbortController. */
  signal: AbortSignal;
}

// ─── Infrastructure types (unchanged) ────────────────────────────────

export interface FileStore {
  read<T>(path: string): Promise<T | null>;
  write<T>(path: string, data: T): Promise<void>;
  append<T>(path: string, line: T): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface ScopedState {
  get<T>(scope: string, key: string): T | undefined;
  set<T>(scope: string, key: string, value: T): void;
  entries(scope: string): Record<string, unknown>;
}

export interface Logger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
  debug(data: Record<string, unknown>, message: string): void;
}

export type { EntryConfig };

// ─── Error codes & FlowError ─────────────────────────────────────────

export type FlowErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_VIOLATION"
  | "CONFIRMATION_REQUIRED"
  | "STALE_HEAD"
  | "CONFLICT"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "REVIEW_PUBLISH_DISABLED"
  | "TIMEOUT"
  | "FAILED";

export class FlowError extends Error {
  readonly code: FlowErrorCode;
  readonly publicMessage: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(opts: {
    code: FlowErrorCode;
    message: string;
    publicMessage?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = "FlowError";
    this.code = opts.code;
    this.publicMessage = opts.publicMessage ?? opts.message;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

// ─── Execution record (written by executeFlow) ───────────────────────

export interface ExecutionRecord {
  flow_name: string;
  execution_id: string;
  input: unknown;
  output: unknown;
  started_at: string;
  finished_at: string;
  error: string | null;
  error_code?: string;
  duration_ms: number;
  /** True when the result was served from an earlier execution (idempotency hit). */
  replayed?: boolean;
  invocation_source?: string;
  invocation_id?: string;
  parent_id?: string;
  session_id?: string;
  delivery_id?: string;
}
