import type { SessionEvent, SessionListEvent } from "@cfpa/contracts/api";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api.ts";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export function useSessionEvents(id: string | undefined, onEvent: (event: SessionEvent) => void): ConnectionState {
  const [state, setState] = useState<ConnectionState>("disconnected");
  const handler = useRef(onEvent);

  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (id === undefined || id === "") {
      setState("disconnected");
      return;
    }
    setState("connecting");
    const source = new EventSource(api.sessionEventsUrl(id), { withCredentials: true });
    let failures = 0;
    source.onopen = () => {
      failures = 0;
      setState("connected");
    };
    source.onerror = () => {
      failures += 1;
      if (failures >= 5) {
        source.close();
      }
      setState("disconnected");
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as SessionEvent;
        if (event.type === "ping") return;
        handler.current(event);
      } catch {
        setState("disconnected");
      }
    };
    return () => {
      source.close();
      setState("disconnected");
    };
  }, [id]);

  return state;
}

/** 订阅会话摘要变化，SSE 断线重连后补一次，避免断连期间漏事件。 */
export function useSessionsFeed(onChange: () => void): void {
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let opened = false;
    const source = new EventSource(api.sessionsEventsUrl(), { withCredentials: true });
    source.onopen = () => {
      if (opened) handler.current();
      opened = true;
    };
    source.onmessage = (message) => {
      try {
        if ((JSON.parse(message.data) as SessionListEvent).type === "changed") handler.current();
      } catch {}
    };
    return () => source.close();
  }, []);
}
