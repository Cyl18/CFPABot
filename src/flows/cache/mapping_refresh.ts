// src/flows/cache/mapping_refresh.ts
// Flow: mapping_refresh — refresh the CurseForge slug-to-project-ID mapping cache.
// Risk: repository_write | Effects: external_read, storage_write
// Concrete Flow wrapper around existing mapping refresh logic.
//
// Spec: docs/specs/02-flow-catalog.md §6

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { refreshMapping } from "../_internal/refresh-mapping.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const mapping_refresh_input = Type.Object({
  force: Type.Optional(
    Type.Boolean({ description: "If true, skip the staleness check and always refresh" }),
  ),
});

export type MappingRefreshInput = Static<typeof mapping_refresh_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const mapping_refresh_output = Type.Object({
  added: Type.Number({ description: "Number of new slug → project ID mappings discovered" }),
  updated: Type.Number({ description: "Number of existing mappings updated" }),
  invalid: Type.Number({ description: "Number of invalid or unresolvable entries" }),
});

export type MappingRefreshOutput = Static<typeof mapping_refresh_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const mapping_refresh: Flow<typeof mapping_refresh_input, typeof mapping_refresh_output> = {
  name: "mapping_refresh",
  description:
    "Refresh the CurseForge slug-to-project-ID mapping by scanning forward from the last scanned project ID. " +
    "Optional 'force' flag bypasses staleness checks. " +
    "Only writes to local storage — does not modify GitHub.",
  input: mapping_refresh_input,
  output: mapping_refresh_output,
  meta: {
    tags: ["cache", "mapping", "curseforge"],
    risk: "repository_write",
    effects: ["storage_write"],
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof mapping_refresh_input>,
  ): Promise<Static<typeof mapping_refresh_output>> {
    const result = await refreshMapping(ctx);
    return {
      added: result.added,
      updated: result.updated,
      invalid: result.invalid,
    };
  },
};
