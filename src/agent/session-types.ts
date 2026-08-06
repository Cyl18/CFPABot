// src/agent/session-types.ts
// Domain types for agent session lifecycle.
// NOT in types.ts because another worker owns that file.
import type { ThinkingLevel } from "./llm-types.js";

export type SessionSource = "github_command" | "frontend";

export type SessionStatus =
  | "idle"
  | "running"
  | "archived"

export interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
  /** Model thinking/reasoning for assistant turns (optional). */
  thinking?: string;
  /** Tool name for toolResult role — identifies which tool produced the result. */
  toolName?: string;
}

/** Pending confirmation persisted in SessionRecord — survives restart. */
export interface PendingConfirmation {
  toolCallId: string;
  flowName: string;
  /** Canonical input hash for binding (SHA-256 truncated). */
  inputHash: string;
  /** Original typed input — persisted for inspection. */
  input: unknown;
}


export interface CreateSessionParams {
  source: SessionSource;
  createdBy: { login: string; githubId: number };
  repo: { owner: string; name: string };
  prNumber?: number;
  baseSha?: string;
  headSha?: string;
  objective: string;
  /** Explicit model selection. Both or neither must be set. */
  modelProvider?: string;
  modelId?: string;
  /** Thinking/reasoning level for models that support it. */
  thinkingLevel?: ThinkingLevel;
  /** Optional dedup key — `${deliveryId}:${commentId}` for webhook /agent. */
  dedupKey?: string;
}
export interface SessionRecord {
  sessionId: string;
  source: SessionSource;
  createdBy: { login: string; githubId: number };
  repo: { owner: string; name: string };
  prNumber?: number;
  baseSha?: string;
  headSha?: string;
  objective: string;
  status: SessionStatus;
  /**
   * Optional breadcrumb of system notices (rejection / stale-pending /
   * agent-failed messages). NOT a transcript mirror — conversation history is
   * served from the pi-coding-agent JSONL at runtime/sessions/transcripts/.
   */
  messages?: SessionMessage[];
  /** Association to pi-coding-agent JSONL transcript file. */
  piSessionFile?: string;
  pendingConfirmation?: PendingConfirmation;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
export interface PendingToolCall<T = unknown> {
  resolve(value: T): void;
  reject(error: Error): void;
  execute(signal?: AbortSignal): Promise<T>;
  execute(): Promise<T>;
  toolCallId: string;
  flowName: string;
  inputHash: string;
  sessionId: string;
  createdAt: number;
  /** Abort signal fired when the session is aborted. The thunk can observe it
   *  to bail out if abort raced ahead of confirmation. */
  abortSignal?: AbortSignal;
}
