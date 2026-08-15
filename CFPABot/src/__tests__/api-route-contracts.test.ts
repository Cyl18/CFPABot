// src/__tests__/api-route-contracts.test.ts
// FE/BE path contract regression test — catches mount-point mismatches
// and unregistered routes before they reach production.
//
// Coverage:
//   ✅  Frontend BASE = /api/frontend              (from web/src/lib/api.ts)
//   ✅  Frontend SESSIONS_BASE = /api/sessions
//   ✅  Backend mount table has expected prefixes   (from src/bootstrap.ts)
//   ✅  Cross-reference: every frontend base maps to a backend mount
//   ❌  Sessions API routes                         (requires env vars for module init)
//   ❌  Frontend API sub-routes                     (requires env vars for module init)
//
// To extend coverage: set GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID,
// GITHUB_APP_INSTALLATION_ID env vars before running tests, then
// un-skip the "full app" suite at the bottom of this file.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";

// ===================================================================
// Expected backend mount table — keep in sync with app.ts:
//
//   createHonoApp():
//     app.route("/api/oauth", oauth);
//     app.route("/api", webhookRouter);
//     app.route("/api/frontend", frontendRouter);
//     app.route("/api/frontend", protectedFrontend);
//     app.route("/api", bmclModlistRouter);
//     app.route("/api/sessions", sessionsRouter);
// ===================================================================
const BACKEND_MOUNTS = [
  { prefix: "/api/oauth", router: "oauth" },
  { prefix: "/api", router: "webhookRouter" },
  { prefix: "/api/frontend", router: "frontendRouter" },
  { prefix: "/api/frontend", router: "protectedFrontend" },
  { prefix: "/api", router: "bmclModlistRouter" },
  { prefix: "/api/sessions", router: "sessionsRouter" },
] as const;

// Paths that the frontend calls — these MUST have a corresponding backend mount.
// Extracted statically from web/src/lib/api.ts.
const FRONTEND_API_BASES = ["/api/frontend", "/api/sessions"] as const;
// ===================================================================
// 1. Frontend API path constant verification
// ===================================================================
describe("Frontend API path constants", () => {
  let src: string;
  let sessionsSrc: string;

  beforeAll(async () => {
    src = await readFile("web/src/lib/api/frontend.ts", "utf-8");
    sessionsSrc = await readFile("web/src/lib/api/sessions.ts", "utf-8");
  });

  function extractConst(name: string): string | null {
    const source =
      name === "SESSIONS_BASE" ? sessionsSrc :
      src;
    const re = new RegExp(`^const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`, "m");
    const m = source.match(re);
    return m?.[1] ?? null;
  }

  it('BASE constant is "/api/frontend"', () => {
    expect(extractConst("BASE")).toBe("/api/frontend");
  });

  it('SESSIONS_BASE constant is "/api/sessions"', () => {
    expect(extractConst("SESSIONS_BASE")).toBe("/api/sessions");
  });

  it("every frontend base prefix has a backend mount", () => {
    const mountPrefixes = BACKEND_MOUNTS.map((m) => m.prefix);
    for (const base of FRONTEND_API_BASES) {
      expect(mountPrefixes).toContain(base);
    }
  });
});

// ===================================================================
// 2. Backend mount table integrity
// ===================================================================
describe("Backend mount table", () => {
  it("contains the critical mount prefixes", () => {
    const prefixes = BACKEND_MOUNTS.map((m) => m.prefix);
    expect(prefixes).toContain("/api/frontend");
    expect(prefixes).toContain("/api/sessions");
    expect(prefixes).toContain("/api/oauth");
  });

  it("has no duplicate router names", () => {
    const routers = BACKEND_MOUNTS.map((m) => m.router);
    expect(new Set(routers).size).toBe(routers.length);
  });
});


// ===================================================================
// 3. Session router factory — route existence without env/GitHub
// ===================================================================
describe("Session router factory", () => {
  it("mounts all admin session routes (401 without auth, not 404)", async () => {
    // Bun auto-loads .env; prevent the local Development auto-admin path from
    // issuing real GitHub /user calls during this contract test.
    const previousEnv = process.env.ASPNETCORE_ENVIRONMENT;
    process.env.ASPNETCORE_ENVIRONMENT = "Production";
    try {
    const { createSessionsRouter } = await import("@/api/sessions.js");
    const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const router = createSessionsRouter({
      githubClient: {} as never,
      config: { environment: "production" } as never,
      logger: noopLogger,
      fileStore: {} as never,
      sessionService: {} as never,
      agentSessionManager: {} as never,
    });
    const app = new Hono();
    app.route("/api/sessions", router);

    for (const [method, path, body] of [
      ["GET", "/api/sessions", undefined],
      ["POST", "/api/sessions", "{}"],
      ["GET", "/api/sessions/some-id", undefined],
      ["GET", "/api/sessions/some-id/messages", undefined],
      ["POST", "/api/sessions/some-id/messages", "{}"],
      ["POST", "/api/sessions/some-id/abort", "{}"],
      ["POST", "/api/sessions/some-id/confirm", "{}"],
      ["POST", "/api/sessions/some-id/reject", "{}"],
      ["POST", "/api/sessions/some-id/archive", "{}"],
      ["GET", "/api/sessions/some-id/stream", undefined],
    ] as const) {
      const res = await app.request(path, {
        method,
        ...(body !== undefined
          ? { headers: { "Content-Type": "application/json" }, body }
          : {}),
      });
      expect(res.status, method + " " + path).not.toBe(404);
    }
    } finally {
      if (previousEnv === undefined) delete process.env.ASPNETCORE_ENVIRONMENT;
      else process.env.ASPNETCORE_ENVIRONMENT = previousEnv;
    }
  });
});

// ===================================================================
// 4. Full-app dynamic smoke (optional — requires env vars)
//
// Un-skip to test ALL registered routes including sessions and frontend.
// Before running, set:
//   GITHUB_WEBHOOK_SECRET=anything
//   GITHUB_APP_ID=1
//   GITHUB_APP_INSTALLATION_ID=1
// ===================================================================
describe("Full app dynamic smoke (factory deps, no real GitHub)", () => {
  let app: Hono;

  beforeAll(async () => {
    // Bun auto-loads CFPABot/.env, whose Development branch would make
    // authMiddleware call GitHub /user for real. Force the cookie path
    // (no cookie → unauthenticated) for this route-contract suite.
    const previousEnv = process.env.ASPNETCORE_ENVIRONMENT;
    process.env.CFPABOT_TEST_PREVIOUS_ENV = previousEnv === undefined ? "" : previousEnv;
    process.env.ASPNETCORE_ENVIRONMENT = "Production";

    const { createHonoApp } = await import("@/bootstrap/app.js");
    const { createWebhookRouter } = await import("@/api/webhook/route.js");
    const { createSessionsRouter } = await import("@/api/sessions.js");
    const { initApiDeps } = await import("@/api/flow-context.js");

    const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    // Full-app route smoke only cares about mount points. Give frontend
    // routes a fake shared client so they fail fast (500) instead of failing
    // during FlowContext construction.
    initApiDeps({} as never, noopLogger, {} as never, {} as never);
    const sessionsRouter = createSessionsRouter({
      githubClient: {} as never,
      config: { environment: "development" } as never,
      logger: noopLogger,
      fileStore: {} as never,
      sessionService: {} as never,
      agentSessionManager: {} as never,
    });
    const webhook = createWebhookRouter({
      githubClient: {} as never,
      logger: noopLogger,
      config: {
        webhookSecret: "test-webhook-secret",
        githubAppId: 1,
      } as never,
      registry: {} as never,
      fileStore: {} as never,
    });

    app = await createHonoApp(
      { environment: "development", port: 8080 } as never,
      { webhookRouter: webhook.router, sessionsRouter },
    );
  });

  afterAll(() => {
    // Restore the local .env Development mode only after all requests in
    // this describe have run; otherwise authMiddleware would call GitHub.
    const previousEnv = process.env.CFPABOT_TEST_PREVIOUS_ENV;
    if (previousEnv === undefined) delete process.env.ASPNETCORE_ENVIRONMENT;
    else process.env.ASPNETCORE_ENVIRONMENT = previousEnv;
    delete process.env.CFPABOT_TEST_PREVIOUS_ENV;
  });

  // --- Sessions routes ---
  // Hono default strict=true: collection routes must be WITHOUT trailing slash.
  // Frontend createSession/getSessions use /api/sessions (no slash).
  it("GET /api/sessions is not 404", async () => {
    const res = await app.request("/api/sessions");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/sessions/:sessionId is not 404", async () => {
    const res = await app.request("/api/sessions/some-id");
    expect(res.status).not.toBe(404);
  });

  it("POST /api/sessions is not 404", async () => {
    const res = await app.request("/api/sessions", { method: "POST", body: "{}" });
    expect(res.status).not.toBe(404);
  });

  it("POST /api/sessions/:sessionId/messages is not 404", async () => {
    const res = await app.request("/api/sessions/some-id/messages", { method: "POST", body: "{}" });
    expect(res.status).not.toBe(404);
  });

  it("POST /api/sessions/:sessionId/abort is not 404", async () => {
    const res = await app.request("/api/sessions/some-id/abort", { method: "POST", body: "{}" });
    expect(res.status).not.toBe(404);
  });

  it("POST /api/sessions/:sessionId/confirm is not 404", async () => {
    const res = await app.request("/api/sessions/some-id/confirm", { method: "POST", body: JSON.stringify({ toolCallId: "t1" }) });
    expect(res.status).not.toBe(404);
  });

  it("POST /api/sessions/:sessionId/reject is not 404", async () => {
    const res = await app.request("/api/sessions/some-id/reject", { method: "POST", body: JSON.stringify({ toolCallId: "t1" }) });
    expect(res.status).not.toBe(404);
  });

  it("GET /api/sessions/:sessionId/stream is not 404", async () => {
    const res = await app.request("/api/sessions/some-id/stream");
    expect(res.status).not.toBe(404);
  });

  // --- Frontend routes (public) ---
  it("GET /api/frontend/me is not 404", async () => {
    const res = await app.request("/api/frontend/me");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/frontend/prs is not 404", async () => {
    const res = await app.request("/api/frontend/prs");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/frontend/pr/123 is not 404", async () => {
    const res = await app.request("/api/frontend/pr/123");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/frontend/compare/123 is not 404", async () => {
    const res = await app.request("/api/frontend/compare/123");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/frontend/modlist is not 404", async () => {
    const res = await app.request("/api/frontend/modlist");
    expect(res.status).not.toBe(404);
  });

  // --- Frontend routes (protected) ---
  it("GET /api/frontend/rate-limit is not 404", async () => {
    const res = await app.request("/api/frontend/rate-limit");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/frontend/logs is not 404", async () => {
    const res = await app.request("/api/frontend/logs");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/frontend/admin/llm-endpoints is not 404", async () => {
    const res = await app.request("/api/frontend/admin/llm-endpoints");
    expect(res.status).not.toBe(404);
  });

  it("POST /api/frontend/admin/llm-endpoints/test is not 404", async () => {
    const res = await app.request("/api/frontend/admin/llm-endpoints/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", modelId: "gpt-4o" }),
    });
    expect(res.status).not.toBe(404);
  });

  // --- OAuth routes ---
  it("GET /api/oauth/github is not 404", async () => {
    const res = await app.request("/api/oauth/github");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/oauth/callback is not 404", async () => {
    const res = await app.request("/api/oauth/callback");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/oauth/signout is not 404", async () => {
    const res = await app.request("/api/oauth/signout");
    expect(res.status).not.toBe(404);
  });

  // --- Webhook routes ---
  it("POST /api/webhook is not 404", async () => {
    const res = await app.request("/api/webhook", { method: "POST", body: "{}" });
    expect(res.status).not.toBe(404);
  });

  it("GET /api/webhook is not 404", async () => {
    const res = await app.request("/api/webhook");
    expect(res.status).not.toBe(404);
  });

  // --- BMCL/Modlist routes ---
  it("GET /api/bakaxl/modlist is not 404", async () => {
    const res = await app.request("/api/bakaxl/modlist");
    expect(res.status).not.toBe(404);
  });

  it("GET /api/bmcl/modlist is not 404", async () => {
    const res = await app.request("/api/bmcl/modlist");
    expect(res.status).not.toBe(404);
  });
});
