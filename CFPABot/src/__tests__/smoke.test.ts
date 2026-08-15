// src/__tests__/smoke.test.ts
// Backend smoke suite. Deliberately minimal: boot-critical contracts only.
// Policy: no fine-grained unit tests. Add tests only for startup/critical path.

import { existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Type } from "typebox";
import { PiRuntime } from "@/agent/pi-runtime.js";
import { createWebhookRouter } from "@/api/webhook/route.js";
import { createFlowRegistry } from "@/engine/registry.js";
import { executeFlow } from "@/engine/execute.js";
import { createAllPublicFlows } from "@/flows/index.js";
import { createMockContext } from "./helpers/mock-context.js";
import { createPrefixedStore } from "./helpers/prefixed-store.js";
import type { FileStore, Flow, FlowError } from "@/types.js";
import type { FlowRegistry } from "@/engine/registry.js";

const TEST_ROOT = "temp/test-smoke";
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

beforeAll(() => {
  mkdirSync(`${TEST_ROOT}/runtime/ops/executions`, { recursive: true });
  mkdirSync(`${TEST_ROOT}/runtime/ops/idempotency`, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("backend smoke", () => {
  it("registers all public flows and exposes representative names", () => {
    const registry = createFlowRegistry();
    const flows = createAllPublicFlows();
    for (const flow of flows) registry.register(flow);

    expect(registry.list().length).toBeGreaterThan(0);
    expect(registry.get("pr_get_context").name).toBe("pr_get_context");
    expect(registry.get("mapping_refresh").name).toBe("mapping_refresh");
  });

  it("executes a simple read flow through the engine", async () => {
    const SimpleInput = Type.Object({ prNumber: Type.Number() });
    const SimpleOutput = Type.Object({ ok: Type.Boolean() });
    const flow: Flow<typeof SimpleInput, typeof SimpleOutput> = {
      name: "smoke_execute",
      description: "smoke",
      input: SimpleInput,
      output: SimpleOutput,
      meta: { tags: ["test"], risk: "read", effects: [] },
      execute: async () => ({ ok: true }),
    };

    const ctx = createMockContext({ store: createPrefixedStore(TEST_ROOT) });
    const result = await executeFlow(flow, ctx, { prNumber: 1 });
    expect(result).toEqual({ ok: true });
  });

  it("rejects invalid flow input", async () => {
    const Input = Type.Object({ prNumber: Type.Number() });
    const Output = Type.Object({ ok: Type.Boolean() });
    const flow: Flow<typeof Input, typeof Output> = {
      name: "smoke_validate",
      description: "smoke",
      input: Input,
      output: Output,
      meta: { tags: ["test"], risk: "read", effects: [] },
      execute: async () => ({ ok: true }),
    };

    const ctx = createMockContext({ store: createPrefixedStore(TEST_ROOT) });
    try {
      await executeFlow(flow, ctx, { prNumber: "bad" } as never);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as FlowError).code).toBe("INVALID_INPUT");
    }
  });

  it("loads pi-mcp-adapter extension + project skill without persisting auth", async () => {
    const cwd = process.cwd();
    const agentDir = join(cwd, "config/pi-agent");
    const authPath = join(agentDir, "auth.json");
    const authExisted = existsSync(authPath);
    const prevPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const runtime = new PiRuntime(cwd, agentDir);
      const services = await runtime.createServices("smoke");
      const snapshot = runtime.inspectResources(services);

      expect(snapshot.extensions.some((e) => e.path.includes("pi-mcp-adapter"))).toBe(true);
      expect(snapshot.extensions.flatMap((e) => e.tools)).toContain("mcp");
      expect(snapshot.skills.map((s) => s.name)).toContain("translation-review");
      expect(snapshot.extensionErrors).toEqual([]);

      if (!authExisted) expect(existsSync(authPath)).toBe(false);
    } finally {
      if (prevPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevPiAgentDir;
    }
  });

  it("keeps transcript paths inside runtime/sessions/transcripts", () => {
    const temp = mkdtempSync(join(tmpdir(), "cfpabot-smoke-"));
    try {
      const runtime = new PiRuntime(temp, join(temp, "agent"));
      expect(runtime.openOrCreateSessionManager().createdPath).toMatch(
        /^runtime\/sessions\/transcripts\//,
      );
      expect(() => runtime.openOrCreateSessionManager("../../escape.jsonl")).toThrow(
        "Invalid piSessionFile path",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("webhook rejects a bad HMAC before running any flow", async () => {
    const registry = makeWebhookRegistry();
    const controller = createWebhookRouter({
      githubClient: {} as never,
      logger: noopLogger,
      config: { webhookSecret: "secret", githubAppId: 1 } as never,
      registry,
      fileStore: makeStore(),
    });
    const app = new Hono();
    app.route("/api", controller.router);

    const res = await app.request("/api/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "bad-sig",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });

    expect(res.status).toBe(401);
  });
});

// ─── Minimal webhook fakes ───────────────────────────────────────────

function makeStore(): FileStore {
  return { read: async () => null, write: async () => {}, append: async () => {}, list: async () => [] };
}

function makeWebhookRegistry(): FlowRegistry {
  const flow: Flow = {
    name: "smoke_webhook",
    description: "smoke",
    input: Type.Object({}),
    output: Type.Object({}),
    meta: { tags: ["test"], risk: "read", effects: [] },
    execute: async () => ({}),
  };
  return {
    register: () => {},
    unregister: () => false,
    get: () => flow,
    list: () => [flow],
    findByTag: () => [],
  };
}
