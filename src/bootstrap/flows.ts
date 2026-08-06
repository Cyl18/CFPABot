// src/bootstrap/flows.ts
// Flow registry creation + flow registration at startup.
// Mirrors the legacy bootstrap() §3 verbatim.

import type { EntryConfig } from "../config.js";
import type { Logger } from "../types.js";
import type { TerminologyProvider } from "../client/terminology/types.js";
import { createFlowRegistry } from "../engine/registry.js";
import { setSharedRegistry } from "../engine/registry-store.js";
import type { FlowRegistry } from "../engine/registry.js";
import type { Flow } from "../types.js";
import { createAllPublicFlows, type CreatePublicFlowsOptions } from "../flows/index.js";
import type { SessionService } from "../agent/session-service.js";

export interface FlowDeps {
  sessionService: SessionService;
}


/**
 * Create a fresh FlowRegistry, build all public flows with injected deps,
 * register them, and publish the registry as the shared singleton.
 * Side effects: populates registry, calls setSharedRegistry.
 */
export function registerFlows(
  deps: FlowDeps,
  config: EntryConfig,
  logger: Logger,
): FlowRegistry {
  const registry: FlowRegistry = createFlowRegistry();

  // Optional terminology providers (empty array = not configured)
  const terminologyProviders: TerminologyProvider[] = [];

  // Build full options for createAllPublicFlows
  const flowOptions: CreatePublicFlowsOptions = {
    terminologyProviders,
    sessionService: deps.sessionService,
  } as CreatePublicFlowsOptions;

  // Create all public Flows with injected dependencies
  const publicFlows: Flow[] = createAllPublicFlows(flowOptions);
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
