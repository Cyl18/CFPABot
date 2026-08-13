// src/engine/registry.ts
// Flow registry — register, discover, query Flows.

import type { Flow, Logger } from "@/types.js";

// Module-level logger injection — set once at bootstrap via initRegistryLogger().
// 避免本模块直接依赖 pino;未注入时静默降级。
let _logger: Logger | null = null;
export function initRegistryLogger(logger: Logger): void {
  _logger = logger;
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
      if (flows.has(flow.name)) {
        _logger?.warn({ flowName: flow.name }, `Flow registry: 覆盖已注册的 Flow "${flow.name}"`);
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
