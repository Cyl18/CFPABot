import { LRUCache } from "lru-cache";

export interface TtlCache<V> {
  get(k: string): V | undefined;
  set(k: string, v: V): void;
  delete(k: string): void;
  wrap(k: string, fn: () => Promise<V>): Promise<V>;
}

export function ttlCache<V>(ttlMs: number, max = 500): TtlCache<V> {
  const cache = new LRUCache<string, NonNullable<V>>({
    max,
    ttl: ttlMs,
    fetchMethod: (_key, _stale, { context }) => (context as () => Promise<NonNullable<V>>)(),
  });
  return {
    get: (k) => cache.get(k),
    set: (k, v) => {
      cache.set(k, v as NonNullable<V>);
    },
    delete: (k) => {
      cache.delete(k);
    },
    wrap: async (k, fn) => (await cache.fetch(k, { context: fn })) as V,
  };
}
