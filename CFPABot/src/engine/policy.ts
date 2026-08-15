// src/engine/policy.ts
// Single source of truth for Flow risk policy decisions.
//
// Both execution paths consult this module:
// - engine/execute.ts enforces programmatic invocation rules;
// - agent/flow-adapter.ts decides whether an Agent tool call requires an
//   admin confirmation.
//
// Keeping the risk thresholds here prevents the two paths from drifting.

import type { FlowRisk } from "@/types.js";

/** Risks that require an admin confirmation when invoked by an Agent. */
export function requiresAgentConfirmation(risk: FlowRisk): boolean {
  return risk === "repository_write" || risk === "destructive";
}

/** Risks that a non-Agent caller may never execute without going through a
 *  dedicated admin-authenticated command path. executeFlow is the final
 *  backstop; command routes must perform their own principal check first. */
export function isProgrammaticExecutionAllowed(risk: FlowRisk): boolean {
  return risk !== "destructive";
}
