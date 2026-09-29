export interface TtlCache<V> {
  get(k: string): V | undefined;
  set(k: string, v: V): void;
  delete(k: string): void;
  wrap(k: string, fn: () => Promise<V>): Promise<V>;
}

export function ttlCache<V>(ttlMs: number, max = 500): TtlCache<V> {
  const values = new Map<string, { at: number; v: V }>();
  const pending = new Map<string, Promise<V>>();

  function evict(): void {
    while (values.size > max) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) return;
      values.delete(oldest);
    }
  }

  function get(k: string): V | undefined {
    const hit = values.get(k);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= ttlMs) {
      values.delete(k);
      return undefined;
    }
    values.delete(k);
    values.set(k, hit);
    return hit.v;
  }

  return {
    get,
    set(k, v) {
      values.delete(k);
      values.set(k, { at: Date.now(), v });
      evict();
    },
    delete(k) {
      values.delete(k);
    },
    wrap(k, fn) {
      const hit = get(k);
      if (hit !== undefined) return Promise.resolve(hit);
      const inflight = pending.get(k);
      if (inflight) return inflight;
      const run = fn().then(
        (v) => {
          pending.delete(k);
          values.delete(k);
          values.set(k, { at: Date.now(), v });
          evict();
          return v;
        },
        (err: unknown) => {
          pending.delete(k);
          throw err;
        },
      );
      pending.set(k, run);
      return run;
    },
  };
}
