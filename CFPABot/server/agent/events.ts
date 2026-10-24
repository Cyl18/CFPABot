import type { SessionEvent } from "@cfpa/contracts/api";
import { logger } from "../log.ts";

const log = logger("agent-events");

export class SessionHub {
  private listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  private watchers = new Set<(sessionId: string) => void>();

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
    if (set) {
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch (err) {
          set.delete(listener);
          log.warn("订阅者抛出异常，已移除", { sessionId, err });
        }
      }
    }
    if (event.type === "status" || event.type === "artifact") this.touch(sessionId);
  }

  /** 订阅会话摘要（状态、时间、草稿计数）的变化，与具体会话无关。 */
  subscribeAll(listener: (sessionId: string) => void): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  touch(sessionId: string): void {
    for (const listener of [...this.watchers]) {
      try {
        listener(sessionId);
      } catch (err) {
        this.watchers.delete(listener);
        log.warn("列表订阅者抛出异常，已移除", { sessionId, err });
      }
    }
  }

  clear(sessionId: string): void {
    this.listeners.delete(sessionId);
  }
}
