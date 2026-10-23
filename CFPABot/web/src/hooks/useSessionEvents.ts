import type { SessionEvent } from "@cfpa/contracts/api";
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
    source.onopen = () => setState("connected");
    source.onerror = () => setState("disconnected");
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
