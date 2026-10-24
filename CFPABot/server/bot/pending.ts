import { withLock } from "../store.ts";

const inflight = new Set<Promise<unknown>>();

export function track<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = withLock(key, fn);
  const wrapped = run.catch(() => undefined);
  inflight.add(wrapped);
  void wrapped.finally(() => inflight.delete(wrapped));
  return run;
}

export async function drainPending(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}
