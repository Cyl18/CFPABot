// src/agent/session-state-store.ts
// SessionStateStore — persistence/consistency layer for agent sessions.
// Owns the in-memory SessionRecord map, the per-session serialized mutation
// queue, lazy disk load (with legacy status normalization) and the
// disk-backed dedup index. Pure consistency: no lifecycle semantics, no
// confirmation rendezvous, no SSE. SessionService (session-service.ts)
// composes it for lifecycle orchestration — the two evolve independently
// (e.g. swapping FileStore for SQLite later touches only this file).
//
// Split from session-service.ts (2026-08-03): pure relocation, no behavior
// change. The serialized-mutation contract is unchanged: concurrent updates
// to one session are queued; each mutation reads, clones, writes, re-caches.

import { perKeyQueue } from "./_shared/serialized-queue.js";
import type { FileStore, Logger } from "@/types.js";
import type { CreateSessionParams, SessionRecord, SessionStatus } from "./session-types.js";
import {
  SESSIONS_DIR,
  SESSIONS_DEDUP_DIR,
  sessionPath,
  dedupPath,
} from "../runtime-paths.js";

const DEDUP_DIR = SESSIONS_DEDUP_DIR;

export class SessionStateStore {
  private sessions = new Map<string, SessionRecord>();
  /** Per-session serialized mutation queue. */
  private mutationQueues = new Map<string, Promise<void>>();
  /** Per-key serialized queue for dedup check-then-write — prevents TOCTOU races. */
  private dedupLocks = new Map<string, Promise<unknown>>();
  /** Whether the in-memory sessions map has been loaded from disk. */
  private sessionsLoaded = false;
  /** In-flight load promise — dedupes concurrent first-access loads. */
  private loadingPromise: Promise<void> | null = null;
  private store: FileStore;
  private logger: Logger;

  constructor(store: FileStore, logger: Logger) {
    this.store = store;
    this.logger = logger;
  }

  // ─── Read ─────────────────────────────────────────────────────────

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    // Single-process invariant: every mutation updates this cache before it
    // resolves. Returning the cached record avoids a disk read per poll
    // (agent loops poll pendingConfirmation frequently).
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    const path = sessionPath(sessionId);
    const record = await this.store.read<SessionRecord>(path);
    if (record) {
      this.sessions.set(sessionId, record);
    }
    return record ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    await this.ensureLoaded();
    return [...this.sessions.values()];
  }

  // ─── Lazy load with legacy normalization ──────────────────────────

  /**
   * Lazily load all persisted sessions from disk into the in-memory map.
   * Idempotent: concurrent callers share a single in-flight load.
   * Called on first access that needs the warm map (listSessions, create paths).
   * Recovery = load SessionRecord JSON into Map only; NO auto-resume of
   * ReAct/running agents. Legacy statuses (created/waiting_confirmation/
   * completed/failed/aborted) are normalized to idle and stale
   * pendingConfirmation cleared — confirm/reject returns 404 afterwards
   * (documented in confirmAction).
   */
  async ensureLoaded(): Promise<void> {
    if (this.sessionsLoaded) return;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = (async () => {
      let files: string[];
      try {
        files = await this.store.list(SESSIONS_DIR);
      } catch {
        this.sessionsLoaded = true;
        return;
      }
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      let count = 0;
      for (const file of jsonFiles) {
        const sessionId = file.replace(/\.json$/, "");
        try {
          const record = await this.store.read<SessionRecord>(`${SESSIONS_DIR}/${file}`);
          if (record?.sessionId) {
            this.sessions.set(record.sessionId, record);
            count++;
          }
        } catch (err) {
          this.logger.warn({ err: String(err), file }, "Failed to load session on lazy recovery — skipping");
        }
      }
      // 进程重启后, 遗留的 running 会话没有对应的内存 runLoop —— 回收为 idle。
      // 历史状态机 (created/waiting_confirmation/completed/failed/aborted) 在
      // 二进制状态机下同样归一为 idle;带 pendingConfirmation 的遗留记录没有
      // 对应的内存 promise, 必须清掉, 否则会话永远卡在 409 无法继续。
      for (const z of [...this.sessions.values()]) {
        if (z.status === "archived") continue;
        if (z.status !== "idle" && z.status !== "running") {
          await this.mutate(z.sessionId, (s) => {
            if (s.status === "archived") return;
            s.status = "idle";
            s.pendingConfirmation = undefined;
            s.updatedAt = new Date().toISOString();
          }).catch(() => {});
          this.logger.warn({ sessionId: z.sessionId, from: z.status }, "Recovered legacy session → idle");
        } else if (z.status === "running") {
          await this.updateStatus(z.sessionId, "idle").catch(() => {});
          this.logger.warn({ sessionId: z.sessionId }, "Recovered zombie running session → idle");
        }
      }
      this.sessionsLoaded = true;
      this.logger.info({ count }, "Recovered persisted sessions");
    })();
    return this.loadingPromise;
  }

  // ─── Create ───────────────────────────────────────────────────────

  /** Build a fresh idle SessionRecord from create params (shared by both create paths). */
  private buildRecord(params: CreateSessionParams): SessionRecord {
    return {
      sessionId: crypto.randomUUID(),
      source: params.source,
      createdBy: { ...params.createdBy },
      repo: { ...params.repo },
      prNumber: params.prNumber,
      baseSha: params.baseSha,
      headSha: params.headSha,
      objective: params.objective,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
      ...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
      status: "idle",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async createSessionRecord(params: CreateSessionParams): Promise<SessionRecord> {
    const session = this.buildRecord(params);
    this.sessions.set(session.sessionId, session);
    await this.mutate(session.sessionId, () => {});
    return session;
  }

  // ─── Serialized mutation ──────────────────────────────────────────

  /** Generic status write (used by load-time zombie normalization). */
  async updateStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord | null> {
    return this.mutate(sessionId, (s) => {
      s.status = status;
      s.updatedAt = new Date().toISOString();
    });
  }

  /**
   * Serialized per-session mutation queue.
   * Each mutation reads the current session state, applies changes,
   * and atomically writes back. Concurrent mutations for the same session
   * are queued and run sequentially.
   */
  async mutate(
    sessionId: string,
    updater: (session: SessionRecord) => void,
  ): Promise<SessionRecord | null> {
    return perKeyQueue(this.mutationQueues, sessionId, async () => {
      let session = this.sessions.get(sessionId);
      if (!session) {
        const disk = await this.store.read<SessionRecord>(sessionPath(sessionId));
        if (!disk) return null;
        this.sessions.set(sessionId, disk);
        session = disk;
      }
      const clone = JSON.parse(JSON.stringify(session)) as SessionRecord;
      updater(clone);
      await this.store.write(sessionPath(sessionId), clone);
      this.sessions.set(sessionId, clone);
      return clone;
    });
  }

  // ─── Dedup index ──────────────────────────────────────────────────

  /**
   * Deterministic hash of a dedup key for collision-free filesystem encoding.
   * Uses full SHA-256 hex digest (64 characters) — no truncation,
   * zero collision risk.
   */
  private async computeDedupHash(dedupKey: string): Promise<string> {
    const data = new TextEncoder().encode(dedupKey);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async dedupPath(dedupKey: string): Promise<string> {
    const hex = await this.computeDedupHash(dedupKey);
    return `${DEDUP_DIR}/${hex}.json`;
  }

  /**
   * Look up a session ID by its dedup key.
   * Returns the session ID if found, or null if not.
   */
  private async getSessionIdByDedupKey(dedupKey: string): Promise<string | null> {
    const mapping = await this.store.read<{ sessionId: string }>(await this.dedupPath(dedupKey));
    return mapping?.sessionId ?? null;
  }

  /**
   * Create a session with dedup — or return the existing one.
   *
   * Uses a per-key serialized lock to prevent TOCTOU: concurrent requests
   * with the same dedupKey queue and only the first creates the session;
   * subsequent calls return the existing session.
   *
   * The `created` flag lets callers distinguish new vs. reused sessions.
   */
  async createOrGetDedup(params: CreateSessionParams): Promise<{ session: SessionRecord; created: boolean }> {
    await this.ensureLoaded();
    const dedupKey = params.dedupKey;
    if (!dedupKey) {
      // No dedup requested — behave like a plain createSession
      const session = await this.createSessionRecord(params);
      return { session, created: true };
    }

    const lockKey = `dedup:${dedupKey}`;
    const prev = this.dedupLocks.get(lockKey) ?? Promise.resolve();

    // Chain onto the per-key queue so concurrent same-key calls serialize
    const next = prev
      .catch(() => undefined)
      .then(async (): Promise<{ session: SessionRecord; created: boolean }> => {
        // Check if dedup mapping already exists (in-process or disk)
        const existingId = await this.getSessionIdByDedupKey(dedupKey);
        if (existingId) {
          const existing = await this.getSession(existingId);
          if (existing) return { session: existing, created: false };
        }

        // No existing session — create new one
        const session = this.buildRecord(params);

        // Write dedup mapping FIRST (so it's visible before the session record)
        await this.store.write(await this.dedupPath(dedupKey), { sessionId: session.sessionId });

        // Then cache and persist the session record
        this.sessions.set(session.sessionId, session);
        await this.mutate(session.sessionId, () => {});

        return { session, created: true };
      })
      .finally(() => {
        // Drop the per-key entry once the tail settles; identity guard ensures
        // we only delete if no newer call has taken its place in the queue.
        if (this.dedupLocks.get(lockKey) === next) {
          this.dedupLocks.delete(lockKey);
        }
      });
    this.dedupLocks.set(lockKey, next);
    return next;
  }
}
