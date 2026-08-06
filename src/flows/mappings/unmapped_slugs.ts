// src/flows/mappings/unmapped_slugs.ts
// Flow: dev_unmapped_slugs — list slugs in modlist without a CF mapping.
// Risk: read | Effects: none (pure local-cache reads)
// Returns the set difference between readModlistCache and readCurseforgeMapping.
// Extracted from api/frontend/dev/index.ts GET /dev/unmapped-slugs.
// This is a dev-only diagnostic flow; not agent-callable.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { readCurseforgeMapping, readModlistCache } from "@/client/cache.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const unmapped_slugs_input = Type.Object({
  /** Cap the number of unmapped slugs returned (default 1000, max 5000) */
  limit: Type.Optional(
    Type.Number({ description: "Cap response size (default 1000)" }),
  ),
});

export type UnmappedSlugsInput = Static<typeof unmapped_slugs_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const unmapped_slugs_output = Type.Object({
  total: Type.Number({ description: "Total unmapped slugs (capped to limit)" }),
  totalModlistEntries: Type.Number({ description: "Total entries in modlist cache" }),
  mappedCount: Type.Number({ description: "Number of slugs with CF mappings" }),
  lastScannedId: Type.Optional(Type.Number()),
  mappingUpdatedAt: Type.Optional(Type.String()),
  error: Type.Optional(Type.String({ description: "Error string (e.g. 'modlist_missing')" })),
  slugs: Type.Array(
    Type.Object({
      slug: Type.String(),
      versions: Type.Array(Type.String()),
    }),
    { description: "Unmapped slugs paired with versions" },
  ),
});

export type UnmappedSlugsOutput = Static<typeof unmapped_slugs_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const dev_unmapped_slugs: Flow<typeof unmapped_slugs_input, typeof unmapped_slugs_output> = {
  name: "dev_unmapped_slugs",
  description:
    "List slugs in modlist.json that lack a CF mapping entry. " +
    "Dev-only diagnostic: returns set difference between modlist and mapping caches. " +
    "Does not modify any files — pure read.",
  input: unmapped_slugs_input,
  output: unmapped_slugs_output,
  meta: {
    tags: ["dev", "mappings", "diagnostic"],
    risk: "read",
    effects: [],
    agent_callable: false,
  },

  async execute(
    _ctx: FlowContext,
    input: Static<typeof unmapped_slugs_input>,
  ): Promise<Static<typeof unmapped_slugs_output>> {
    const cap = input.limit ?? 1000;

    // Read mapping
    const mappingData = await readCurseforgeMapping();
    const mappedSlugs = new Set(Object.keys(mappingData?.mapping ?? {}));
    const lastScannedId = mappingData?.lastScannedId ?? 0;
    const mappingUpdatedAt = mappingData?.updatedAt ?? "";

    // Read modlist
    const modlistData = await readModlistCache();
    let totalModlistEntries = 0;
    const unmapped: Array<{ slug: string; versions: string[] }> = [];
    if (modlistData) {
      totalModlistEntries = modlistData.data.length;
      for (const entry of modlistData.data) {
        if (!mappedSlugs.has(entry.slug)) {
          unmapped.push({ slug: entry.slug, versions: entry.versions });
        }
      }
    }

    return {
      total: unmapped.length,
      totalModlistEntries,
      mappedCount: mappedSlugs.size,
      lastScannedId,
      mappingUpdatedAt,
      error: modlistData ? undefined : "modlist_missing",
      // Cap response size
      slugs: unmapped.slice(0, cap),
    };
  },
};
