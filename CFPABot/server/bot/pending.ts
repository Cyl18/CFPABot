const inflight = new Set<Promise<unknown>>();

export function track<T>(promise: Promise<T>): Promise<T> {
  const wrapped = promise.catch(() => undefined);
  inflight.add(wrapped);
  void wrapped.finally(() => inflight.delete(wrapped));
  return promise;
}

export async function drainPending(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}
