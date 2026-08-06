// src/__tests__/integration.test.ts
// Smoke test: flow registry completeness + basic executeFlow + cron task structure.
// No external I/O, no env var dependencies.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { createFlowRegistry } from "@/engine/registry.js";
import { createMockContext } from "./helpers/mock-context.js";
import { createPrefixedStore } from "./helpers/prefixed-store.js";
import { executeFlow } from "@/engine/execute.js";
import { createAllPublicFlows } from "@/flows/index.js";
import { createCronTasks, type CronTaskDeps } from "@/cron-tasks/index.js";
import { createCleanupTask } from "@/cron-tasks/cleanup.js";
import { Type, type Static } from "typebox";
import type { Flow, FlowContext, FlowError } from "@/types.js";

// ─── Helpers ────────────────────────────────────────────────────────

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const TEST_ROOT = "temp/test-integration";

beforeAll(async () => {
  await mkdir(`${TEST_ROOT}/runtime/ops/idempotency`, { recursive: true });
  await mkdir(`${TEST_ROOT}/runtime/ops/executions`, { recursive: true });
});

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(`${TEST_ROOT}/runtime/ops/idempotency`, { recursive: true });
  await mkdir(`${TEST_ROOT}/runtime/ops/executions`, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// ─── 1. Flow registry ──────────────────────────────────────────────

describe("Flow registry smoke", () => {
  it("registers all public flows and looks them up by name", () => {
    const registry = createFlowRegistry();
    const flows = createAllPublicFlows();
    for (const flow of flows) {
      registry.register(flow);
    }

    expect(registry.list().length).toBe(flows.length);
    expect(registry.list().length).toBeGreaterThanOrEqual(26);

    // Spot-check representative flows
    expect(registry.get("pr_get_context").name).toBe("pr_get_context");
    expect(registry.get("mapping_refresh").name).toBe("mapping_refresh");
    expect(registry.get("packer_auto_approve").name).toBe("packer_auto_approve");
  });

  it("throws for unregistered flows", () => {
    const registry = createFlowRegistry();
    expect(() => registry.get("nonexistent")).toThrow("Flow not found");
  });

  it("finds flows by tag", () => {
    const registry = createFlowRegistry();
    const flows = createAllPublicFlows();
    for (const flow of flows) registry.register(flow);

    const cacheFlows = registry.findByTag("cache");
    expect(cacheFlows.length).toBeGreaterThanOrEqual(3);
    expect(cacheFlows.some((f) => f.name === "mapping_refresh")).toBe(true);
  });
});

// ─── 2. Cron tasks ─────────────────────────────────────────────────

describe("Cron task smoke", () => {
  const makeDeps = (): CronTaskDeps => {
    const registry = createFlowRegistry();
    const flows = createAllPublicFlows();
    for (const flow of flows) registry.register(flow);
    return {
      registry,
      github: createMockContext({ store: createPrefixedStore(TEST_ROOT) }).github,
      config: createMockContext({ store: createPrefixedStore(TEST_ROOT) }).config,
      logger: noopLogger as never,
    };
  };

  it("creates all expected cron tasks", () => {
    const deps = makeDeps();
    const tasks = createCronTasks(deps);
    const names = tasks.map((t) => t.name);

    expect(names).toContain("modlist-refresh");
    expect(names).toContain("pr-cache-refresh");
    expect(names).toContain("cleanup");
  });

  it("cleanup task is infrastructure-only", () => {
    const task = createCleanupTask(noopLogger as never);
    expect(task.name).toBe("cleanup");
    expect(task.intervalMs).toBe(24 * 3600_000);
  });
});

// ─── 3. Basic executeFlow ──────────────────────────────────────────

describe("executeFlow smoke", () => {
  const SimpleInput = Type.Object({
    prNumber: Type.Number(),
    headSha: Type.String(),
  });
  type SimpleInputT = Static<typeof SimpleInput>;

  const SimpleOutput = Type.Object({
    ok: Type.Boolean(),
  });

  it("executes a simple flow and returns typed output", async () => {
    const flow: Flow<typeof SimpleInput, typeof SimpleOutput> = {
      name: "smoke_test",
      description: "Smoke test flow.",
      input: SimpleInput,
      output: SimpleOutput,
      meta: { tags: ["test"], risk: "read", effects: [] },
      execute: async () => ({ ok: true }),
    };

    const ctx = createMockContext({ store: createPrefixedStore(TEST_ROOT) });
    const result = await executeFlow(flow, ctx, { prNumber: 1, headSha: "abc" });
    expect(result).toEqual({ ok: true });
  });

  it("rejects invalid input", async () => {
    const flow: Flow<typeof SimpleInput, typeof SimpleOutput> = {
      name: "validate_input",
      description: "Input validation test.",
      input: SimpleInput,
      output: SimpleOutput,
      meta: { tags: ["test"], risk: "read", effects: [] },
      execute: async () => ({ ok: true }),
    };

    const ctx = createMockContext({ store: createPrefixedStore(TEST_ROOT) });
    try {
      await executeFlow(flow, ctx, { prNumber: "bad" } as unknown as SimpleInputT);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      const err = e as FlowError;
      expect(err.code).toBe("INVALID_INPUT");
    }
  });
});
