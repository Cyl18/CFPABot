// src/__tests__/webhook-route.test.ts
// Tests for the webhook router factory:
// - HMAC/auth rejection
// - duplicate delivery dedup
// - POST returns 202 before background Flow execution completes
// - shutdown drains tracked background work

import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import { Hono } from "hono";
import { Type } from "typebox";
import type { Flow, FileStore } from "@/types.js";
import type { FlowRegistry } from "@/engine/registry.js";
import { createWebhookRouter } from "@/api/webhook/route.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeStore(): FileStore {
  return {
    read: async () => null,
    write: async () => {},
    append: async () => {},
    list: async () => [],
  };
}

function makeRegistry(onExecute: () => Promise<unknown>): FlowRegistry {
  const flow: Flow = {
    name: "modlist_refresh",
    description: "test flow",
    input: Type.Object({ force: Type.Optional(Type.Boolean()) }),
    output: Type.Object({
      version: Type.Number(),
      count: Type.Number(),
      updatedAt: Type.String(),
    }),
    meta: {
      tags: ["test"],
      risk: "repository_write",
      effects: ["storage_write"],
    },
    execute: async () => (await onExecute()) as never,
  };
  return {
    register: () => {},
    unregister: () => false,
    get: () => flow,
    list: () => [flow],
    findByTag: () => [],
  };
}

function makeApp(controller: ReturnType<typeof createWebhookRouter>): Hono {
  const app = new Hono();
  app.route("/api", controller.router);
  return app;
}

function pushPayload(): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    after: "abc123",
    sender: { login: "admin" },
    repository: {
      owner: { login: "CFPAOrg" },
      name: "Minecraft-Mod-Language-Package",
    },
  };
}

function signature(raw: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
}

describe("createWebhookRouter", () => {
  it("rejects an invalid HMAC signature before scheduling work", async () => {
    let calls = 0;
    const controller = createWebhookRouter({
      githubClient: {} as never,
      logger: noopLogger,
      config: { webhookSecret: "secret", githubAppId: 1 } as never,
      registry: makeRegistry(async () => { calls++; }),
      fileStore: makeStore(),
    });
    const app = makeApp(controller);
    const raw = JSON.stringify(pushPayload());
    const res = await app.request("/api/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "bad-sig",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: raw,
    });

    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("returns 202 before the background Flow finishes, and drains it", async () => {
    let release!: () => void;
    let calls = 0;
    let settled = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = createWebhookRouter({
      githubClient: {} as never,
      logger: noopLogger,
      config: { webhookSecret: "secret", githubAppId: 1 } as never,
      registry: makeRegistry(async () => {
        calls++;
        await gate;
        settled = true;
      }),
      fileStore: makeStore(),
    });
    const app = makeApp(controller);
    const raw = JSON.stringify(pushPayload());
    const res = await app.request("/api/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "d1",
        "x-hub-signature-256": signature(raw, "secret"),
      },
      body: raw,
    });

    // The HTTP response must not wait for modlist_refresh to finish.
    expect(res.status).toBe(202);
    expect(settled).toBe(false);

    // Release the gated Flow and prove the controller drains it.
    release();
    await controller.waitForWebhookOps(2_000);
    expect(calls).toBe(1);
    expect(settled).toBe(true);
  });

  it("deduplicates repeated delivery ids", async () => {
    let calls = 0;
    const controller = createWebhookRouter({
      githubClient: {} as never,
      logger: noopLogger,
      config: { webhookSecret: "secret", githubAppId: 1 } as never,
      registry: makeRegistry(async () => { calls++; }),
      fileStore: makeStore(),
    });
    const app = makeApp(controller);
    const raw = JSON.stringify(pushPayload());
    const headers = {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "dup-1",
      "x-hub-signature-256": signature(raw, "secret"),
    };
    const first = await app.request("/api/webhook", { method: "POST", headers, body: raw });
    const second = await app.request("/api/webhook", { method: "POST", headers, body: raw });
    await controller.waitForWebhookOps(2_000);

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("returns 503 while shutting down", async () => {
    const controller = createWebhookRouter({
      githubClient: {} as never,
      logger: noopLogger,
      config: { webhookSecret: "secret", githubAppId: 1 } as never,
      registry: makeRegistry(async () => {}),
      fileStore: makeStore(),
    });
    const app = makeApp(controller);
    controller.setShuttingDown(true);
    const res = await app.request("/api/webhook", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });
});
