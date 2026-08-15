// src/bootstrap/flows.ts
// Flow registry creation + flow registration at startup.
// Mirrors the legacy bootstrap() §3 verbatim.

import type { Logger } from "../types.js";
import { createFlowRegistry } from "../engine/registry.js";
import { setSharedRegistry } from "../engine/registry-store.js";
import type { FlowRegistry } from "../engine/registry.js";
import type { Flow } from "../types.js";
import { createAllPublicFlows } from "../flows/index.js";

/**
 * Create a fresh FlowRegistry, build all public flows, register them, and
 * publish the registry as the shared singleton.
 * Side effects: populates registry, calls setSharedRegistry.
 */
export function registerFlows(logger: Logger): FlowRegistry {
  const registry: FlowRegistry = createFlowRegistry();

  const publicFlows: Flow[] = createAllPublicFlows();
  for (const flow of publicFlows) {
    registry.register(flow);
  }
  logger.info(
    { flowCount: publicFlows.length },
    "所有公开 Flow 已注册",
  );
  // Set shared registry for AgentSessionManager/createAgent tool loading
  setSharedRegistry(registry);
  return registry;
}
