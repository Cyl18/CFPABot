// src/flows/pr/pr_find_related.ts
// Flow: pr_find_related — find open PRs that share the same project slug/domain/version.
// Uses PR relation cache (client/pr-relations-cache.ts) + _shared parseProjectPath.
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { getRelationsForPR } from "@/client/pr-relations-cache.js";
import { parseProjectPath } from "../_shared/project-path/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const pr_find_related_input = Type.Object({
  prNumber: Type.Number({ description: "PR number to find relations for" }),
  projectPaths: Type.Optional(
    Type.Array(Type.String(), { description: "Explicit project paths to check (optional, uses PR files if omitted)" }),
  ),
});

export type PrFindRelatedInput = Static<typeof pr_find_related_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const pr_find_related_output = Type.Object({
  prNumber: Type.Number(),
  relations: Type.Array(
    Type.Object({
      prNumber: Type.Number(),
      sharedSlugs: Type.Array(Type.String()),
      reasons: Type.Array(Type.String()),
    }),
  ),
  totalRelations: Type.Number(),
});

export type PrFindRelatedOutput = Static<typeof pr_find_related_output>;

// ─── Flow Definition ────────────────────────────────────────────────────

export const pr_find_related: Flow<typeof pr_find_related_input, typeof pr_find_related_output> = {
  name: "pr_find_related",
  description: "Find open PRs that overlap with the given PR by shared mod slug, domain, or game version. Uses the PR relation cache (slug→PR cross-reference).",
  input: pr_find_related_input,
  output: pr_find_related_output,
  meta: {
    tags: ["pr", "query"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_find_related_input>): Promise<Static<typeof pr_find_related_output>> {
    const { prNumber, projectPaths } = input;

    // Parse project paths if provided; otherwise use PR files
    let pathsToCheck: string[] = projectPaths ?? [];

    if (!pathsToCheck.length) {
      try {
        const files = await ctx.github.getPullRequestFiles(prNumber);
        pathsToCheck = files.map((f) => f.filename);
      } catch (err) {
        ctx.logger.warn({ prNumber, err: String(err) }, "pr_find_related: failed to fetch PR files");

        return {
          prNumber,
          relations: [],
          totalRelations: 0,
        };
      }
    }


    // Query PR relations cache — returns { slug, version, others: PRRelationEntry[] }
    let relations: Array<{ prNumber: number; sharedSlugs: string[]; reasons: string[] }> = [];
    try {
      const cachedRelations = getRelationsForPR(prNumber);
      for (const rel of cachedRelations) {
        for (const other of rel.others) {
          relations.push({
            prNumber: other.prNumber,
            sharedSlugs: [rel.slug],
            reasons: [`共享模组 ${rel.slug} (版本 ${rel.version})`],
          });
        }
      }
    } catch (err) {
      ctx.logger.warn({ prNumber, err: String(err) }, "pr_find_related: relation cache error");
    }

    return {
      prNumber,
      relations,
      totalRelations: relations.length,
    };
  },
};
