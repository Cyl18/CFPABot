// src/engine/lock.ts
// Process-level async mutual exclusion via named keys.
// Uses a promise-chain: each acquirer waits for the previous to finish.
// No I/O, no external dependencies.

type ReleaseFn = () => void;

const locks = new Map<string, Promise<void>>();

/**
 * Acquire an async lock for the given key.
 * Returns a release function that MUST be called (typically in a finally block).
 *
 * Usage:
 *   const release = await acquireLock("my-key");
 *   try {
 *     // critical section
 *   } finally {
 *     release();
 *   }
 */
export async function acquireLock(key: string): Promise<ReleaseFn> {
  // Chain onto the previous lock for this key, or start with a resolved promise
  const prev = locks.get(key) ?? Promise.resolve();

  const { promise: next, resolve } = Promise.withResolvers<void>();

  // Register the new gatekeeper before anyone can observe the gap
  locks.set(key, next);

  // Wait for our turn (waits for prev to resolve, then we hold the lock)
  await prev;

  // We now hold the lock. Return a release function that resolves the promise,
  // allowing the next waiter to proceed.
  return () => {
    // Only clean up if no one replaced our entry
    if (locks.get(key) === next) {
      locks.delete(key);
    }
    resolve();
  };
}

/**
 * Check whether a lock is currently held for the given key.
 */
export function isLocked(key: string): boolean {
  return locks.has(key);
}
