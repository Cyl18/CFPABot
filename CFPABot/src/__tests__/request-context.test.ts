// src/__tests__/request-context.test.ts
// AsyncLocalStorage request-signal propagation used by the Octokit hook.

import { describe, it, expect } from "bun:test";
import { runWithRequestSignal, currentRequestSignal } from "@/client/request-context.js";

describe("request signal context", () => {
  it("is visible inside the async call chain and absent outside", async () => {
    expect(currentRequestSignal()).toBeUndefined();

    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    await runWithRequestSignal(controller.signal, async () => {
      await Promise.resolve();
      seen.push(currentRequestSignal());
    });

    expect(seen).toEqual([controller.signal]);
    expect(currentRequestSignal()).toBeUndefined();
  });
});
