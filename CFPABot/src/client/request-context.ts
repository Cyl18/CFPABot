// src/client/request-context.ts
// Propagates the active Flow invocation's AbortSignal to outbound transport
// layers without threading `signal` through every GitHubClient method.
//
// executeFlow runs each Flow inside runWithTimeout(); that function wraps the
// Flow.execute() call in runWithRequestSignal(). Octokit's request hook reads
// currentRequestSignal() and attaches it as `request.signal`, so a timeout or
// session abort actually cancels the HTTP request instead of merely racing it.

import { AsyncLocalStorage } from "node:async_hooks";

const requestSignalStore = new AsyncLocalStorage<AbortSignal>();

export function runWithRequestSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return requestSignalStore.run(signal, fn);
}

export function currentRequestSignal(): AbortSignal | undefined {
  return requestSignalStore.getStore();
}
