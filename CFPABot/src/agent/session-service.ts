// src/agent/session-service.ts
// SessionService — the sole lifecycle boundary for agent sessions.
// Durable SessionRecord at runtime/sessions/{uuid}.json.
// Owns AgentSessionManager delegation — API routes call SessionService only.
// Active pending-confirmation rendezvous: adapter registers a promise,
// confirm/reject resolves/rejects it, only the exact toolCallId recovers.
//
// Split (2026-08-03): persistence/consistency moved to SessionStateStore
// (session-state-store.ts); this file keeps lifecycle semantics — status
// transitions, confirmation rendezvous (with its three-actor race guards)
// and terminal-state side effects (ctx snapshot + abort signal).
// SessionStateStore's public API is the ONLY persistence surface used here.

import { clearSessionCtx } from "./session-ctx.js";
import { persistSessionCtx } from "./ctx-store.js";
import { SessionStateStore } from "./session-state-store.js";
import type { FileStore, Logger } from "@/types.js";
import type {
  SessionRecord,
  SessionStatus,
  SessionMessage,
  CreateSessionParams,
  PendingConfirmation,
  PendingToolCall,
} from "./session-types.js";
export type ToolResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
};

/**
 * Compute a deterministic input hash for confirmation binding.
 * Uses SHA-256 truncated to 16 chars — sufficient for change detection.
 */
export async function computeInputHash(input: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(input));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export class SessionService {
  /** Persistence/consistency layer — serialized mutation queue + disk. */
  private state: SessionStateStore;
  /** In-memory pending tool call promises — NOT persisted; recovered sessions have their pendingConfirmation cleared on boot. */
  private pendingToolCalls = new Map<string, PendingToolCall<ToolResult>>();
  /** Per-session abort signals — fired by abortSession so in-flight thunks
   *  ( confirmation → pending.execute ) can detect cancellation without a
   *  back-reference to PiSessionManager.
   *  Entries are released at terminal transitions via releaseAbortController:
   *  never deleting leaks one controller per historical session, and a cached
   *  aborted controller would make every later confirmation of a continued
   *  session fail its abortSignal.aborted check (confirmAction). */
  private sessionAbort = new Map<string, AbortController>();
  private logger: Logger;
  sseBroadcast?: (sessionId: string, event: Record<string, unknown>) => void;

  constructor(store: FileStore, logger: Logger) {
    this.state = new SessionStateStore(store, logger);
    this.logger = logger;
  }

  // ─── Session CRUD (delegated to state layer) ──────────────────────

  async createSession(params: CreateSessionParams): Promise<SessionRecord> {
    return this.state.createSessionRecord(params);
  }

  async createOrGetSession(params: CreateSessionParams): Promise<{ session: SessionRecord; created: boolean }> {
    return this.state.createOrGetDedup(params);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.state.getSession(sessionId);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.state.listSessions();
  }

  // ─── Status transitions ───────────────────────────────────────────

  async updateStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord | null> {
    return this.state.updateStatus(sessionId, status);
  }

  async startRunning(sessionId: string): Promise<boolean> {
    // 原子 check-and-set:状态检查在 mutation 队列内完成,两个并发
    // startSession/continueSession 不会同时通过检查(TOCTOU 竞态会导致
    // 同一会话跑两个 ReAct 循环、副作用重复执行)。
    let started = false;
    await this.state.mutate(sessionId, (s) => {
      if (s.status !== "idle") return;
      s.status = "running";
      s.updatedAt = new Date().toISOString();
      started = true;
    });
    return started;
  }

  // ─── Messages ─────────────────────────────────────────────────────

  async addMessage(sessionId: string, role: string, content: string, timestamp?: string): Promise<SessionRecord | null> {
    return this.state.mutate(sessionId, (s) => {
      if (!s.messages) s.messages = [];
      const msg: SessionMessage = { role, content, timestamp: timestamp ?? new Date().toISOString() };
      s.messages.push(msg);
      s.updatedAt = new Date().toISOString();
    });
  }
  /**
   * Associate a pi-coding-agent transcript file path with a session.
   * Called once when AgentSession creates a new transcript.
   * The path is relative to the project root.
   */
  async setPiSessionFile(sessionId: string, piSessionFile: string): Promise<void> {
    return this.state.mutate(sessionId, (s) => {
      s.piSessionFile = piSessionFile;
      s.updatedAt = new Date().toISOString();
    }).then(() => undefined);
  }

  // ─── Confirmation — pending promise rendezvous ────────────────────

  /**
   * Abort signal for a session. AbortSession() fires it; a confirmAction's
   * thunk can observe it via AbortSignal.any to bail out if abort raced
   * ahead of confirmation. Separate from PiSessionManager's own controller.
   */
  abortSignal(sessionId: string): AbortSignal {
    let ac = this.sessionAbort.get(sessionId);
    if (!ac) {
      ac = new AbortController();
      this.sessionAbort.set(sessionId, ac);
    }
    return ac.signal;
  }

  /**
   * Drop the per-session abort controller. Idempotent (no-op when absent).
   * Safe because PendingToolCall holds its own signal reference — deletion
   * never affects in-flight confirmation abort checks; a later confirmation
   * lazily gets a fresh controller. Called at terminal transitions:
   * abortSession, archiveSession, and finalizeSession (normal completion).
   */
  releaseAbortController(sessionId: string): void {
    this.sessionAbort.delete(sessionId);
  }

  /**
   * Register a pending tool call and await confirmation/rejection.
   * The returned promise blocks the tool adapter until the admin confirms
   * (resolves via executeThunk) or rejects.
   */
  async registerAndAwaitConfirmation(
    sessionId: string,
    toolCallId: string,
    flowName: string,
    input: unknown,
    inputHash: string,
    executeThunk: (signal?: AbortSignal) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const key = `${sessionId}:${toolCallId}`;

    // Register the in-memory promise FIRST so confirmAction always finds it
    // (after a sync call — before any await yields to the event loop).
    const { promise, resolve, reject } = Promise.withResolvers<ToolResult>();
    const pending: PendingToolCall<ToolResult> = {
      resolve,
      reject,
      execute: executeThunk,
      toolCallId,
      flowName,
      inputHash,
      sessionId,
      createdAt: Date.now(),
      abortSignal: this.abortSignal(sessionId),
    };
    this.pendingToolCalls.set(key, pending);

    // Persist to disk — if this fails, clean up the in-memory pending entry
    // so no dangling promise is left behind.
    try {
      await this.state.mutate(sessionId, (s) => {
        if (s.status === "archived") {
          // Archived is terminal — never overwrite it while a confirmation is in flight.
          throw Object.assign(new Error(`Session is ${s.status}`), {
            code: "SESSION_TERMINATED",
            retryable: false,
          });
        }
        s.pendingConfirmation = { toolCallId, flowName, inputHash, input };
        s.updatedAt = new Date().toISOString();
      });
    } catch (err) {
      this.pendingToolCalls.delete(key);
      throw err; // propagate so the tool adapter sees the failure
    }

    this.sseBroadcast?.(sessionId, {
      type: "pending_confirmation",
      toolCallId,
      flowName,
      inputHash,
      input,
    });

    return promise;
  }

  /**
   * Confirm a pending action. Executes the held tool call and resolves
   * the pending promise so the agent sees the result directly.
   */
  async confirmAction(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ flowName: string; inputHash: string } | null> {
    const key = `${sessionId}:${toolCallId}`;
    const pending = this.pendingToolCalls.get(key);
    if (!pending) {
      // No in-memory pending promise — either already processed, or
      // session was aborted (abortSession clears both pendingToolCalls
      // and persisted pendingConfirmation). Never downgrade aborted→failed.
      const session = await this.getSession(sessionId);
      if (session?.status === "archived") return null;

      if (session?.pendingConfirmation?.toolCallId === toolCallId) {
        this.logger.warn(
          { sessionId, toolCallId, flowName: session.pendingConfirmation.flowName },
          "Pending confirmation found on disk but no in-memory promise — rejecting safely",
        );
        const staleFlowName = session.pendingConfirmation.flowName;
        await this.state.mutate(sessionId, (s) => {
          s.pendingConfirmation = undefined;
          s.status = "idle";
          if (!s.messages) s.messages = [];
          s.messages.push({
            role: "system",
            content: `服务器重启后待确认的操作 "${staleFlowName}" 已自动失效，请重新发起会话。`,
            timestamp: new Date().toISOString(),
          });
          s.updatedAt = new Date().toISOString();
        });
        this.sseBroadcast?.(sessionId, {
          type: "session_status",
          status: "idle",
          pendingConfirmation: null,
        });
      }
      return null;
    }

    const { flowName, inputHash } = pending;

    // Atomically verify state and transition inside the serialized mutation queue
    const result = await this.state.mutate(sessionId, (s) => {
      if (s.status === "archived") {
        // Archived is terminal — never overwrite it while a confirmation is in flight.
        throw Object.assign(new Error(`Session was ${s.status} before confirmation`), {
          code: "SESSION_TERMINATED",
          retryable: false,
        });
      }
      if (s.pendingConfirmation?.toolCallId !== toolCallId) {
        throw Object.assign(new Error("Pending confirmation no longer matches"), {
          code: "PENDING_MISMATCH",
          retryable: false,
        });
      }
      s.pendingConfirmation = undefined;
      s.status = "running";
      s.updatedAt = new Date().toISOString();
    });

    // Mutate returned null → session not found
    if (!result) {
      this.pendingToolCalls.delete(key);
      return null;
    }

    // Broadcast status change so SSE subscribers leave the pending state
    this.sseBroadcast?.(sessionId, {
      type: "session_status",
      status: "running",
      pendingConfirmation: null,
    });

    // Execute the held tool call (guaranteed successful state transition)
    // Final race guard: abortSession fires the session's abort signal before
    // its own mutate. If it raced ahead of this confirmation, do NOT execute
    // the thunk (the session is being torn down).
    if (pending.abortSignal?.aborted) {
      this.pendingToolCalls.delete(key);
      const abortErr = Object.assign(new Error("Session was aborted during confirmation"), {
        code: "SESSION_ABORTED",
        retryable: false,
      });
      pending.reject(abortErr);
      throw abortErr;
    }

    try {
      const execResult = await pending.execute(pending.abortSignal);
      pending.resolve(execResult);
      this.pendingToolCalls.delete(key);
      return { flowName, inputHash };
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)));
      this.pendingToolCalls.delete(key);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Reject a pending action. Rejects the pending promise so the agent
   * receives a structured rejection result.
   */
  async rejectAction(
    sessionId: string,
    toolCallId: string,
  ): Promise<boolean> {
    const key = `${sessionId}:${toolCallId}`;
    const pending = this.pendingToolCalls.get(key);
    if (!pending) return false;

    const flowName = pending.flowName;

    // Atomically verify state and transition inside the serialized mutation queue.
    // If abortSession's mutate ran first (status → "idle", pendingConfirmation
    // cleared), this sees the idle status with no pending confirmation and fails
    // the PENDING_MISMATCH check — the reject is a no-op.
    let transitioned = false;
    try {
      const result = await this.state.mutate(sessionId, (s) => {
        if (s.status === "archived") {
          throw Object.assign(new Error(`Session was ${s.status} before rejection could complete`), {
            code: "SESSION_TERMINATED",
            retryable: false,
          });
        }
        if (s.pendingConfirmation?.toolCallId !== toolCallId) {
          throw Object.assign(new Error("Pending confirmation no longer matches"), {
            code: "PENDING_MISMATCH",
            retryable: false,
          });
        }
        s.pendingConfirmation = undefined;
        if (!s.messages) s.messages = [];
        s.messages.push({
          role: "system",
          content: `管理员已拒绝执行操作 "${flowName}"。`,
          timestamp: new Date().toISOString(),
        });
        s.updatedAt = new Date().toISOString();
      });
      if (!result) return false; // session not found
      transitioned = true;
    } catch {
      // Mutate threw due to abort or pending mismatch — rejectAction failed
      return false;
    }

    // Mutate succeeded — pendingConfirmation cleared, session keeps running.
    // Now reject the in-memory promise (best-effort; the agent loop will see the
    // rejection and continue processing it).
    if (transitioned) {
      pending.reject(
        Object.assign(new Error(`Admin rejected "${flowName}"`), {
          code: "CONFIRMATION_REQUIRED",
          publicMessage: `管理员已拒绝执行 "${flowName}"。`,
          retryable: false,
        }),
      );
      this.pendingToolCalls.delete(key);
      // Broadcast status change so SSE subscribers leave the pending state
      this.sseBroadcast?.(sessionId, {
        type: "session_status",
        status: "running",
        pendingConfirmation: null,
      });
    }
    return true;
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const preSession = await this.getSession(sessionId);
    if (!preSession) return false;

    // Fire the per-session abort signal so any in-flight confirmation thunk
    // ( pending.execute ) that races ahead of abort can observe cancellation.
    const ac = this.sessionAbort.get(sessionId);
    if (ac) ac.abort();

    // Atomic state transition inside serialized queue: clear pending confirmation
    // and set status. This ensures confirmAction's mutate (if queued concurrently)
    // sees the aborted status and fails.
    await this.state.mutate(sessionId, (s) => {
      s.pendingConfirmation = undefined;
      s.status = "idle";
      s.updatedAt = new Date().toISOString();
    });

    // Best-effort: reject the in-memory pending promise after state is committed.
    // If the promise was already resolved by confirmAction (which won the queue
    // race), this is a no-op.
    if (preSession.pendingConfirmation) {
      const key = `${sessionId}:${preSession.pendingConfirmation.toolCallId}`;
      const pending = this.pendingToolCalls.get(key);
      if (pending) {
        pending.reject(new Error("Session aborted"));
        this.pendingToolCalls.delete(key);
      }
    }
    // Released after the reject pass: pending holds its own signal reference,
    // and any registration racing this teardown already captured the fired
    // (aborted) signal. Future runs lazily get a fresh controller.
    this.releaseAbortController(sessionId);
    return true;
  }

  /**
   * Soft-archive a session: set status='archived' and persisted archivedAt.
   * Idempotent: if already archived, returns the record as-is.
   * Never hard-deletes the file — archived sessions persist but are filtered from listings.
   *
   * Archive is a terminal state: the running agent loop is aborted (signal
   * fired) and any pending confirmation is rejected, mirroring abortSession —
   * the session must not keep executing writes after an admin archives it.
   */
  async archiveSession(sessionId: string): Promise<SessionRecord | null> {
    const existing = await this.getSession(sessionId);
    if (!existing) return null;
    if (existing.status === "archived") return existing;

    // Fire the per-session abort signal so the ReAct loop's in-flight tool
    // calls observe cancellation (flow-adapter composes this signal).
    const ac = this.sessionAbort.get(sessionId);
    if (ac) ac.abort();

    // Reject any in-flight pending confirmation so the loop cannot execute
    // a held write after archiving.
    if (existing.pendingConfirmation) {
      const key = `${sessionId}:${existing.pendingConfirmation.toolCallId}`;
      const pending = this.pendingToolCalls.get(key);
      if (pending) {
        pending.reject(
          Object.assign(new Error("Session archived"), {
            code: "SESSION_TERMINATED",
            retryable: false,
          }),
        );
        this.pendingToolCalls.delete(key);
      }
    }

    return this.state.mutate(sessionId, (s) => {
      s.status = "archived";
      s.archivedAt = new Date().toISOString();
      s.pendingConfirmation = undefined;
      s.updatedAt = new Date().toISOString();
    }).then(async (record) => {
      // Terminal state — persist ctx snapshot first, then drop in-memory blobs.
      await persistSessionCtx(sessionId);
      clearSessionCtx(sessionId);
      this.releaseAbortController(sessionId);
      return record;
    });
  }
}
