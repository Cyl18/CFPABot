// src/agent/_shared/serialized-queue.ts
// Generic per-key serialized promise queue. Live callers: session-service
// (mutate) and review-run (store enqueue) — both via the perKeyQueue wrapper
// below. The class remains for any future direct use.
//
// Two chaining policies:
// - run(): error-isolating. fn's failure is caught and chain link resolves; next
//   call's fn still runs. Use when sequential ops must not poison each other
//   (mutate / enqueue).
// - chain(): error-propagating. fn's failure rejects the link, which subsequent
//   chain() calls await so errors surface at the peeking site.
//
// Both self-clean the key once the tail settles and no newer call has replaced it
// (identity guard).

export class SerializedQueue {
  private chains = new Map<string, Promise<unknown>>();

  /** Error-isolating sequential run. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    this.chains.set(key, tail);
    return next;
  }

  /** Error-propagating sequential chain — awaiting `tail` rethrows fn's error. */
  chain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    this.chains.set(key, next);
    return next;
  }

  /** Peek at the current tail for a key (await to drain), or undefined if idle. */
  peek(key: string): Promise<unknown> | undefined {
    return this.chains.get(key);
  }

  /** Forget a key (settle its chain without awaiting). Forgetful — does not reject. */
  forget(key: string): void {
    this.chains.delete(key);
  }

  /** Forget every key. */
  clear(): void {
    this.chains.clear();
  }
}

/**
 * Convenience wrapper for the common error-isolating case: chain `fn` onto the
 * per-key tail held in a caller-supplied map. Equivalent to a shared
 * SerializedQueue.run().
 */
export function perKeyQueue<T>(
  map: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = map.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.finally(() => {
    if (map.get(key) === tail) map.delete(key);
  });
  map.set(key, tail);
  return next;
}
