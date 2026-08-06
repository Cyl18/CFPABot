// src/flows/cache/modlist_build.ts
// Flow: modlist_build — build the modlist when cache is empty.
// Risk: read | Effects: github_read, storage_read
// Fallback scan used when runtime/cache/modlist.json is missing.
// Combines local-repo scan (slug/versions from shallow clone) and
// GitHub tree scan (when local clone is absent) into a single response.
// The API layer maps the output to ModlistEntry[] shape (slug/name/cfId/versions/description).
//
// Spec: mods enumeration fallback for GET /api/frontend/modlist.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { createUserTokenGitHubClient } from "@/client/github/index.js";
import { readModSlugs, readModVersions } from "@/client/local-repo.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const modlist_build_input = Type.Object({
  force: Type.Optional(
    Type.Boolean({ description: "Force rebuild even if cache exists" }),
  ),
  defaultBranch: Type.Optional(
    Type.String({ description: "Branch to scan (default: main)" }),
  ),
  /** User OAuth token for tree scan (falls back to bot client when absent) */
  token: Type.Optional(
    Type.String({ description: "User OAuth token (preferred for rate-limit isolation)" }),
  ),
});

export type ModlistBuildInput = Static<typeof modlist_build_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const modlist_build_output = Type.Object({
  source: Type.Union(
    [Type.Literal("local"), Type.Literal("github")],
    { description: "Whether the output came from local repo clone or GitHub tree scan" },
  ),
  mods: Type.Array(
    Type.Object({
      slug: Type.String(),
      versions: Type.Array(Type.String()),
    }),
    { description: "Slugs paired with their version directories (sorted)" },
  ),
});

export type ModlistBuildOutput = Static<typeof modlist_build_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const modlist_build: Flow<typeof modlist_build_input, typeof modlist_build_output> = {
  name: "modlist_build",
  description:
    "Build the modlist by scanning the local repo clone or GitHub tree. " +
    "Used as fallback when runtime/cache/modlist.json is missing. " +
    "Returns raw slug/version pairs (API layer maps to ModlistEntry). " +
    "Does not modify any cache files — pure read.",
  input: modlist_build_input,
  output: modlist_build_output,
  meta: {
    tags: ["cache", "modlist", "fallback"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof modlist_build_input>,
  ): Promise<Static<typeof modlist_build_output>> {
    const branch = input.defaultBranch ?? "main";
    const modVersions = new Map<string, Set<string>>();

    const slugs = await readModSlugs();
    if (slugs.length > 0) {
      // Local FS mode
      for (const slug of slugs) {
        const versions = await readModVersions(slug);
        if (versions.length === 0) continue;
        modVersions.set(slug, new Set(versions));
      }
    } else {
      // GitHub tree scan mode — prefer user token to isolate rate limit
      const client = input.token
        ? createUserTokenGitHubClient(input.token)
        : ctx.github;
      const tree = await client.getGitTree(branch, true);
      if (!tree) {
        throw new FlowError({
          code: "UPSTREAM_UNAVAILABLE",
          message: `Failed to fetch git tree for branch ${branch}`,
        });
      }
      for (const entry of tree) {
        const match = entry.path.match(/^projects\/assets\/([^/]+)\/([^/]+)/);
        if (match) {
          const slug = match[1]!;
          const version = match[2]!;
          if (!modVersions.has(slug)) {
            modVersions.set(slug, new Set());
          }
          modVersions.get(slug)!.add(version);
        }
      }
    }

    const mods = [...modVersions.entries()]
      .map(([slug, versions]) => ({ slug, versions: [...versions].sort() }))
      .sort((a, b) => a.slug.localeCompare(b.slug));

    return {
      source: slugs.length > 0 ? "local" : "github",
      mods,
    };
  },
};

// Backward-compat alias for legacy callers
export const buildModlist = modlist_build;
