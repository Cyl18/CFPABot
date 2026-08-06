// src/flows/cache/modlist_get.ts
// Flow: modlist_get — get the mod list, preferring cached modlist.json
// and falling back to a live build scan when the cache is empty.
// Returns entries in the frontend ModlistEntry shape.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { executeFlow } from "@/engine/execute.js";
import { readModlistCache } from "@/client/cache.js";
import { modlist_build } from "./modlist_build.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const modlist_get_input = Type.Object({
  token: Type.Optional(
    Type.String({ description: "User OAuth token for the fallback tree scan" }),
  ),
});

export type ModlistGetInput = Static<typeof modlist_get_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const modlist_get_output = Type.Object({
  entries: Type.Array(
    Type.Object({
      slug: Type.String(),
      name: Type.String(),
      cfId: Type.Number(),
      versions: Type.Array(Type.String()),
      description: Type.String(),
    }),
  ),
  source: Type.Union([Type.Literal("cache"), Type.Literal("build")]),
});

export type ModlistGetOutput = Static<typeof modlist_get_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const modlist_get: Flow<typeof modlist_get_input, typeof modlist_get_output> = {
  name: "modlist_get",
  description:
    "Get the mod list, preferring cached modlist.json and falling back " +
    "to a live build scan when the cache is empty. " +
    "Returns entries in the frontend ModlistEntry shape.",
  input: modlist_get_input,
  output: modlist_get_output,
  meta: {
    tags: ["cache", "modlist"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof modlist_get_input>,
  ): Promise<Static<typeof modlist_get_output>> {
    // 1. Prefer precomputed cached modlist.json
    const cached = await readModlistCache();
    if (cached && cached.data.length > 0) {
      return {
        entries: cached.data.map((e) => ({
          slug: e.slug,
          name: e.name,
          cfId: e.cfId,
          versions: e.versions,
          description: e.description,
        })),
        source: "cache",
      };
    }

    // 2. Fallback: run modlist_build Flow (local-repo or GitHub tree scan)
    const build = await executeFlow(modlist_build, ctx, { token: input.token });
    return {
      entries: build.mods.map((m) => ({
        slug: m.slug,
        name: m.slug,
        cfId: 0,
        versions: m.versions,
        description: "",
      })),
      source: "build",
    };
  },
};
