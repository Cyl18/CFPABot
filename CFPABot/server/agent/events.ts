import type { SessionEvent } from "@cfpa/contracts/api";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { logger } from "../log.ts";

const log = logger("agent-events");

/** omp 的自动重试是黑盒：不映射成状态事件，前端只能看空白 typing，像卡死。 */
export function statusEventOf(event: AgentSessionEvent): SessionEvent | undefined {
  if (event.type === "auto_retry_start") {
    const seconds = Math.max(1, Math.round(event.delayMs / 1000));
    return {
      type: "status",
      status: "running",
      note: `上游请求失败，约 ${seconds} 秒后自动重试（第 ${event.attempt}/${event.maxAttempts} 次）`,
    };
  }
  if (event.type === "auto_retry_end" && event.success) return { type: "status", status: "running" };
  return undefined;
}

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
