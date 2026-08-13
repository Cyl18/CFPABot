// src/flows/compare/compare_list_workspaces.ts
// Flow: compare_list_workspaces — derive the set of unique workspaces from a PR's
// changed lang files. Returns slugs plus per-workspace file groupings.
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import {
  extractModSet,
  isLangFilePath,
} from "@/flows/_shared/project-path/index.js";

// ─── Input Schema ────────────────────────────────────────────────────

export const compare_list_workspaces_input = Type.Object({
  prNumber: Type.Number({ description: "PR number to derive workspaces from" }),
}, { additionalProperties: false });

export type CompareListWorkspacesInput = Static<typeof compare_list_workspaces_input>;

// ─── Output DTO ──────────────────────────────────────────────────────

export const compare_list_workspaces_output = Type.Object({
  slugs: Type.Array(Type.String(), {
    description: "Unique mod slugs (sorted alphabetically)",
  }),
  workspaces: Type.Array(
    Type.Object({
      slug: Type.String({ description: "Mod slug (namespace folder name)" }),
      version: Type.String({ description: "Game version folder" }),
      namespace: Type.String({ description: "Mod domain / namespace" }),
      files: Type.Array(Type.String(), {
        description: "Raw lang-file paths belonging to this workspace",
      }),
    }),
    { description: "One entry per unique (slug, version, modDomain) workspace" },
  ),
}, { additionalProperties: false });

export type CompareListWorkspacesOutput = Static<typeof compare_list_workspaces_output>;

// ─── Flow Definition ─────────────────────────────────────────────────

export const compare_list_workspaces: Flow<
  typeof compare_list_workspaces_input,
  typeof compare_list_workspaces_output
> = {
  name: "compare_list_workspaces",
  description:
    "从 PR 变更的语言文件中推导出唯一工作区集合（slug/version/namespace），返回 slug 列表及各工作区的文件分组。",
  input: compare_list_workspaces_input,
  output: compare_list_workspaces_output,
  meta: {
    tags: ["compare", "query"],
    risk: "read",
    effects: ["github_read"],
    timeoutMs: 30_000,
    agent_callable: true,
  },

  execute: async (ctx: FlowContext, input: CompareListWorkspacesInput): Promise<CompareListWorkspacesOutput> => {
    const { prNumber } = input;

    // 1. Fetch changed files for the PR.
    const prFiles = await ctx.github.getPullRequestFiles(prNumber);
    const filenames = prFiles.map((f) => f.filename);

    // 2. Filter to only lang files (zh_cn/en_us) — non-lang files never
    //    produce a workspace, so drop them before grouping.
    const langPaths = filenames.filter(isLangFilePath);

    // 3. Parse + dedupe mod identities and collect parsed entries.
    const { identities, entries } = extractModSet(langPaths);

    // 4. Group filtered entries by `${slug}:${gameVersion}:${modDomain}`.
    const groups = new Map<string, { slug: string; version: string; namespace: string; files: string[] }>();
    for (const entry of entries) {
      const { slug, gameVersion, modDomain } = entry.parsed;
      const key = `${slug}:${gameVersion}:${modDomain}`;
      const existing = groups.get(key);
      if (existing) {
        existing.files.push(entry.rawPath);
      } else {
        groups.set(key, {
          slug,
          version: gameVersion,
          namespace: modDomain,
          files: [entry.rawPath],
        });
      }
    }

    // 5. Build sorted unique slugs across identities.
    const slugSet = new Set<string>();
    for (const id of identities) {
      slugSet.add(id.slug);
    }
    const slugs = [...slugSet].sort();

    // 6. Preserve insertion order of workspaces (encounter order is
    //    deterministic from extractModSet).
    const workspaces = [...groups.values()];

    return { slugs, workspaces };
  },
};
