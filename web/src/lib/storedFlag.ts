import { useSyncExternalStore } from "react";

interface Store {
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
}

const stores: Record<string, Store> = {};
const values: Record<string, boolean> = {};

function store(key: string): Store {
  const existing = stores[key];
  if (existing !== undefined) return existing;
  const listeners = new Set<() => void>();
  const created: Store = {
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  stores[key] = created;
  return created;
}

function read(key: string): boolean {
  const cached = values[key];
  if (cached !== undefined) return cached;
  let value = true;
  try {
    value = localStorage.getItem(key) !== "0";
  } catch {}
  values[key] = value;
  return value;
}

export function useStoredFlag(key: string): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    store(key).subscribe,
    () => read(key),
    () => true,
  );
  return [
    value,
    (next: boolean) => {
      values[key] = next;
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {}
      for (const listener of store(key).listeners) listener();
    },
  ];
}
