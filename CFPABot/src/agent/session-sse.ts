// src/agent/session-sse.ts
// SseBroadcaster — SSE subscriber management + broadcast.
// PiSessionManager composes this instead of managing subscribers inline.

import type { Logger } from "@/logger.js";

export type SseSubscriber = (event: Record<string, unknown>) => void;

export class SseBroadcaster {
  private subscribers = new Map<string, Set<SseSubscriber>>();

  constructor(private readonly logger?: Logger) {}

  /** Register a subscriber for a session. Returns an unsubscribe function. */
  subscribe(sessionId: string, subscriber: SseSubscriber): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(subscriber);
    return () => {
      this.subscribers.get(sessionId)?.delete(subscriber);
      if (this.subscribers.get(sessionId)?.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  /** Broadcast an event to all subscribers of a session. */
  broadcast(sessionId: string, event: Record<string, unknown>): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;
    const enriched = { sessionId, ...event };
    for (const fn of subs) {
      try {
        fn(enriched);
      } catch (e) {
        // 注入的 logger 可选 — 未注入时静默
        this.logger?.warn({ sessionId, err: String(e) }, "[SseBroadcaster]: broadcast failed");
        subs.delete(fn);
      }
    }
  }

  /** Clear all subscribers (used by destroy()). */
  clear(): void {
    this.subscribers.clear();
  }

  /** Clear all subscribers for a single session (used on session finalize/abort). */
  clearSession(sessionId: string): void {
    this.subscribers.delete(sessionId);
  }
}
