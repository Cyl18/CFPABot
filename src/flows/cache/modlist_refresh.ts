// src/flows/cache/modlist_refresh.ts
// Flow: modlist_refresh — refresh the mod list cache from the local git repo.
// Risk: repository_write | Effects: external_read, storage_write
// Concrete Flow wrapper around existing modlist refresh logic.
//
// Spec: docs/specs/02-flow-catalog.md §6

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { refreshModlist } from "../_internal/refresh-modlist.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const modlist_refresh_input = Type.Object({
  force: Type.Optional(
    Type.Boolean({ description: "If true, skip the staleness check and always refresh" }),
  ),
});

export type ModlistRefreshInput = Static<typeof modlist_refresh_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const modlist_refresh_output = Type.Object({
  version: Type.Number({ description: "Cache schema version" }),
  count: Type.Number({ description: "Number of mods in the refreshed modlist" }),
  updatedAt: Type.String({ description: "ISO timestamp of the refresh" }),
});

export type ModlistRefreshOutput = Static<typeof modlist_refresh_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const modlist_refresh: Flow<typeof modlist_refresh_input, typeof modlist_refresh_output> = {
  name: "modlist_refresh",
  description:
    "Refresh the mod list cache by scanning the local git repository's project tree. " +
    "The optional 'force' flag bypasses the staleness check. " +
    "Only writes to local storage — does not modify GitHub.",
  input: modlist_refresh_input,
  output: modlist_refresh_output,
  meta: {
    tags: ["cache", "modlist"],
    risk: "repository_write",
    effects: ["storage_write"],
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof modlist_refresh_input>,
  ): Promise<Static<typeof modlist_refresh_output>> {
    const result = await refreshModlist(ctx, undefined, { force: input.force });
    return {
      version: result.version,
      count: result.count,
      updatedAt: result.updatedAt,
    };
  },
};
