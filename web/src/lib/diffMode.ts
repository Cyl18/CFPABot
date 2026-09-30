import { useSyncExternalStore } from "react";
import type { DiffMode } from "@/lib/diff.ts";

export const DIFF_MODES: readonly { id: DiffMode; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "char", label: "按字" },
  { id: "word", label: "按词" },
  { id: "sentence", label: "按句" },
  { id: "off", label: "关闭" },
];

const STORAGE_KEY = "cfpa-diff-mode";

function read(): DiffMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return DIFF_MODES.some((item) => item.id === stored) ? (stored as DiffMode) : "auto";
  } catch {
    return "auto";
  }
}

let current = read();
const listeners = new Set<() => void>();

export function setDiffMode(next: DiffMode): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDiffMode(): [DiffMode, (next: DiffMode) => void] {
  const mode = useSyncExternalStore(
    subscribe,
    () => current,
    () => "auto" as DiffMode,
  );
  return [mode, setDiffMode];
}
