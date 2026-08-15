// src/engine/registry.ts
// Flow registry — register, discover, query Flows.

import type { Flow, FlowEffect, FlowRisk } from "@/types.js";

// Registry metadata validation happens at register() time; startup fails
// fast on contradictory risk/effect/retry metadata instead of discovering
// the drift at runtime.
const FLOW_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ALLOWED_RISKS: ReadonlySet<FlowRisk> = new Set(["read", "review_write", "repository_write", "destructive"]);
const ALLOWED_EFFECTS: ReadonlySet<FlowEffect> = new Set([
  "github_read",
  "github_comment_write",
  "github_metadata_write",
  "github_check_write",
  "github_workflow_write",
  "git_commit",
  "git_push",
  "storage_write",
  "external_write",
]);
const WRITE_EFFECTS: ReadonlySet<FlowEffect> = new Set([
  "github_comment_write",
  "github_metadata_write",
  "github_check_write",
  "github_workflow_write",
  "git_commit",
  "git_push",
  "storage_write",
  "external_write",
]);

/**
 * Validate Flow identity and metadata before registration. Catches the
 * class of drift that is invisible to tsc but dangerous at runtime:
 * - read flows declaring write effects (tm_build previously did this);
 * - write flows without any declared effect;
 * - retry without an idempotency key (would make duplicate writes legal);
 * - invalid names, risks, effects, timeout values.
 */
export function validateFlowDefinition(flow: Flow): void {
  if (!FLOW_NAME_RE.test(flow.name)) {
    throw new Error(`Invalid Flow name: "${flow.name}". Use snake_case, 1-64 chars.`);
  }
  if (!flow.description || flow.description.trim().length === 0) {
    throw new Error(`Flow "${flow.name}" must have a non-empty description.`);
  }
  if (!ALLOWED_RISKS.has(flow.meta.risk)) {
    throw new Error(`Flow "${flow.name}" has unknown risk: ${String(flow.meta.risk)}.`);
  }
  if (!flow.input || !flow.output) {
    throw new Error(`Flow "${flow.name}" must define TypeBox input and output schemas.`);
  }
  if (flow.meta.timeoutMs !== undefined && (!Number.isFinite(flow.meta.timeoutMs) || flow.meta.timeoutMs <= 0)) {
    throw new Error(`Flow "${flow.name}" has invalid timeoutMs: ${flow.meta.timeoutMs}.`);
  }
  for (const effect of flow.meta.effects) {
    if (!ALLOWED_EFFECTS.has(effect)) {
      throw new Error(`Flow "${flow.name}" has unknown effect: ${String(effect)}.`);
    }
  }
  if (flow.meta.risk === "read") {
    const writeEffects = flow.meta.effects.filter((e) => WRITE_EFFECTS.has(e));
    if (writeEffects.length > 0) {
      throw new Error(`Flow "${flow.name}" is risk=read but declares write effects: ${writeEffects.join(", ")}.`);
    }
  } else if (!flow.meta.effects.some((e) => WRITE_EFFECTS.has(e))) {
    throw new Error(`Flow "${flow.name}" is risk=${flow.meta.risk} but declares no write effect.`);
  }
  if (flow.meta.retry) {
    if (flow.meta.retry.maxAttempts < 2 || flow.meta.retry.backoffMs < 1) {
      throw new Error(`Flow "${flow.name}" has invalid retry config.`);
    }
    if (!flow.meta.idempotencyKey) {
      throw new Error(`Flow "${flow.name}" configures retry without idempotencyKey.`);
    }
  }
}

export interface FlowRegistry {
  register(flow: Flow): void;
  unregister(name: string): boolean;
  get(name: string): Flow;
  list(): Flow[];
  findByTag(tag: string): Flow[];
}

export function createFlowRegistry(): FlowRegistry {
  const flows = new Map<string, Flow>();
  // Tag index: tag -> Set<flow name> — rebuilt on every register/unregister.
  // For the expected number of Flows (< 100) this is fast enough.
  const tagIndex = new Map<string, Set<string>>();

  function rebuildTagIndex(): void {
    tagIndex.clear();
    for (const [name, flow] of flows) {
      for (const tag of flow.meta.tags) {
        let set = tagIndex.get(tag);
        if (!set) {
          set = new Set();
          tagIndex.set(tag, set);
        }
        set.add(name);
      }
    }
  }

  return {
    register(flow: Flow): void {
      validateFlowDefinition(flow);
      if (flows.has(flow.name)) {
        throw new Error(`Flow registry: duplicate Flow "${flow.name}" — refusing to overwrite.`);
      }
      flows.set(flow.name, flow);
      // Update tag index
      for (const tag of flow.meta.tags) {
        let set = tagIndex.get(tag);
        if (!set) {
          set = new Set();
          tagIndex.set(tag, set);
        }
        set.add(flow.name);
      }
    },

    unregister(name: string): boolean {
      const deleted = flows.delete(name);
      if (deleted) rebuildTagIndex();
      return deleted;
    },

    get(name: string): Flow {
      const flow = flows.get(name);
      if (!flow) throw new Error(`Flow not found: ${name}`);
      return flow;
    },

    list(): Flow[] {
      return [...flows.values()];
    },

    findByTag(tag: string): Flow[] {
      const names = tagIndex.get(tag);
      if (!names) return [];
      const result: Flow[] = [];
      for (const name of names) {
        const f = flows.get(name);
        if (f) result.push(f);
      }
      return result;
    },
  };
}
