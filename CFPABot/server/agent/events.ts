import type { SessionEvent } from "@cfpa/contracts/api";
import { logger } from "../log.ts";

const log = logger("agent-events");

export class SessionHub {
  private listeners = new Map<string, Set<(event: SessionEvent) => void>>();

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<(event: SessionEvent) => void>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  emit(sessionId: string, event: SessionEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        set.delete(listener);
        log.warn("订阅者抛出异常，已移除", { sessionId, err });
      }
    }
  }

  clear(sessionId: string): void {
    this.listeners.delete(sessionId);
  }
}
