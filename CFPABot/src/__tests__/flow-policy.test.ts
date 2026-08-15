// src/__tests__/flow-policy.test.ts
// Registry-time metadata validation + shared risk policy checks.

import { describe, it, expect } from "bun:test";
import { Type } from "typebox";
import { createFlowRegistry, validateFlowDefinition } from "@/engine/registry.js";
import { createAllPublicFlows } from "@/flows/index.js";
import { requiresAgentConfirmation, isProgrammaticExecutionAllowed } from "@/engine/policy.js";
import { isAgentVisible, AGENT_FLOW_WHITELIST } from "@/agent/flow-policy.js";
import type { Flow } from "@/types.js";

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    name: "test_flow",
    description: "test",
    input: Type.Object({}),
    output: Type.Object({}),
    meta: { tags: [], risk: "read", effects: [] },
    execute: async () => ({}),
    ...overrides,
  } as Flow;
}

describe("Flow metadata validation", () => {
  it("accepts every registered public flow", () => {
    const registry = createFlowRegistry();
    for (const flow of createAllPublicFlows()) registry.register(flow);
    expect(registry.list().length).toBeGreaterThanOrEqual(40);
  });

  it("rejects read flows with write effects", () => {
    expect(() =>
      validateFlowDefinition(makeFlow({ meta: { tags: [], risk: "read", effects: ["storage_write"] } })),
    ).toThrow(/risk=read but declares write effects/);
  });

  it("rejects retry without idempotencyKey", () => {
    expect(() =>
      validateFlowDefinition(makeFlow({
        meta: { tags: [], risk: "repository_write", effects: ["storage_write"], retry: { maxAttempts: 2, backoffMs: 1 } },
      })),
    ).toThrow(/retry without idempotencyKey/);
  });

  it("rejects write risks without write effects", () => {
    expect(() =>
      validateFlowDefinition(makeFlow({ meta: { tags: [], risk: "repository_write", effects: [] } })),
    ).toThrow(/declares no write effect/);
  });

  it("rejects duplicate registration", () => {
    const registry = createFlowRegistry();
    const flow = makeFlow();
    registry.register(flow);
    expect(() => registry.register(flow)).toThrow(/duplicate Flow/);
  });
});

describe("Flow policy", () => {
  it("requires confirmation only for repository_write and destructive", () => {
    expect(requiresAgentConfirmation("read")).toBe(false);
    expect(requiresAgentConfirmation("review_write")).toBe(false);
    expect(requiresAgentConfirmation("repository_write")).toBe(true);
    expect(requiresAgentConfirmation("destructive")).toBe(true);
  });

  it("blocks only destructive flows for programmatic execution", () => {
    expect(isProgrammaticExecutionAllowed("read")).toBe(true);
    expect(isProgrammaticExecutionAllowed("repository_write")).toBe(true);
    expect(isProgrammaticExecutionAllowed("destructive")).toBe(false);
  });

  it("agent whitelist only contains registered flow names", () => {
    const registered = new Set(createAllPublicFlows().map((f) => f.name));
    for (const name of AGENT_FLOW_WHITELIST) {
      expect(registered.has(name), `missing whitelist flow ${name}`).toBe(true);
    }
    expect(isAgentVisible("pr_get_context")).toBe(true);
    expect(isAgentVisible("review_comment")).toBe(false);
  });
});
