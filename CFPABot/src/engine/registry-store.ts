// src/engine/registry-store.ts
// Shared Flow registry store - single source of truth for the global FlowRegistry.
// Set once during bootstrap, accessed by webhook dispatch and agent session manager.

import type { FlowRegistry } from "./registry.js";

let shared: FlowRegistry | null = null;

export function setSharedRegistry(registry: FlowRegistry): void {
  shared = registry;
}

export function getSharedRegistry(): FlowRegistry {
  if (!shared) {
    throw new Error("Flow registry not initialized - call setSharedRegistry() during bootstrap");
  }
  return shared;
}
