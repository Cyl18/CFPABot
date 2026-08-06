// src/flows/pr/pr_compare.ts
// Flow: pr_compare — compare base/head language files, grouped by mod, with
// pagination per mod via opaque string cursor.
// Uses collectLanguagePairs() + shared lang-differ for consistent
// diff semantics with translation_analyze.
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { loadPrDiff, collectLanguagePairs } from "../_internal/index.js";
import { diffLangEntries, filterChangedRows, computeStats } from "../_shared/language/index.js";
import type { DiffRow } from "../_shared/types.js";
import { encodeCursor, decodeCursor } from "./pr_get_diff.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const pr_compare_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.Optional(Type.String({ description: "Expected head SHA — fails STALE_HEAD if mismatch. Omit to use PR's current head." })),
  baseSha: Type.Optional(Type.String({ description: "Base SHA for comparison (default: PR base)" })),
  modPath: Type.Optional(
    Type.String({ description: "Filter to a specific mod path (slug)" }),
  ),
  cursor: Type.Optional(
    Type.String({ description: "Opaque cursor for row pagination. Omit or null for first page." }),
  ),
  pageSize: Type.Optional(
    Type.Number({ description: "Rows per page (default 100, max 500). Must be positive finite." }),
  ),
});

export type PrCompareInput = Static<typeof pr_compare_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const pr_compare_output = Type.Object({
  headSha: Type.String(),
  baseSha: Type.String(),
  mods: Type.Array(
    Type.Object({
      slug: Type.String(),
      gameVersion: Type.String(),
      modDomain: Type.String(),
      stats: Type.Object({
        added: Type.Number(),
        removed: Type.Number(),
        modified: Type.Number(),
        unchanged: Type.Number(),
      }),
      rows: Type.Array(
        Type.Object({
          key: Type.String(),
          baseEn: Type.String(),
          headEn: Type.String(),
          baseCn: Type.String(),
          headCn: Type.String(),
          status: Type.Union([
            Type.Literal("new"),
            Type.Literal("modified"),
            Type.Literal("removed"),
            Type.Literal("unchanged"),
          ]),
        }),
      ),
      hasMore: Type.Boolean(),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  totalMods: Type.Number(),
  errors: Type.Array(
    Type.Object({
      modPath: Type.Optional(
        Type.Object({
          slug: Type.String(),
          gameVersion: Type.String(),
          modDomain: Type.String(),
        }),
      ),
      message: Type.String(),
    }),
  ),
});

export type PrCompareOutput = Static<typeof pr_compare_output>;

// ─── Flow Definition ────────────────────────────────────────────────────

export const pr_compare: Flow<typeof pr_compare_input, typeof pr_compare_output> = {
  name: "pr_compare",
  description: "Compare base vs head language files, grouped by mod. Returns LangDiffLine rows per mod with pagination (opaque string cursor). Uses identical diff logic as translation_analyze. Term findings not included per-mod (use translation_check_terms separately).",
  input: pr_compare_input,
  output: pr_compare_output,
  meta: {
    tags: ["pr", "query", "review"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_compare_input>): Promise<Static<typeof pr_compare_output>> {
    const {
      prNumber,
      headSha,
      baseSha: explicitBaseSha,
      modPath: filterMod,
      cursor,
      pageSize = 100,
    } = input;

    if (!Number.isFinite(pageSize) || pageSize <= 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `pageSize must be positive finite, got ${pageSize}`,
        publicMessage: "每页行数必须为正数",
        retryable: false,
      });
    }

    const cappedPageSize = Math.min(Math.floor(pageSize), 500);
    const pageStart = cursor ? decodeCursor(cursor) : 0;

    // 1. Load PR diff to get changed files + head SHA validation
    const prDiff = await loadPrDiff(ctx, {
      prNumber,
      expectedHeadSha: headSha,
      maxFiles: 1000,
      maxBytes: 5_000_000,
    });

    // Resolve head SHA — use explicit if provided, otherwise from PR diff
    const resolvedHeadSha = headSha ?? prDiff.headSha;

    // 2. Determine base SHA (from PR if not explicitly provided)
    const pr = await ctx.github.getPullRequest(prNumber);
    const baseSha = explicitBaseSha ?? pr.base.sha ?? "";

    // 3. Collect language pairs
    const langResult = await collectLanguagePairs(
      ctx,
      baseSha,
      resolvedHeadSha,
      prDiff.files,
    );

    // 4. Group by mod and compute diffs
    const modResults: Array<{
      slug: string;
      gameVersion: string;
      modDomain: string;
      stats: { added: number; removed: number; modified: number; unchanged: number };
      rows: Array<{
        key: string;
        baseEn: string;
        headEn: string;
        baseCn: string;
        headCn: string;
        status: "new" | "modified" | "removed" | "unchanged";
      }>;
      hasMore: boolean;
      nextCursor: string | null;
    }> = [];

    for (const pair of langResult.pairs) {
      const { slug, gameVersion, modDomain } = pair.modPath;

      // Apply mod filter
      if (filterMod && slug !== filterMod) continue;

      // Diff the language pairs (base zh_cn vs head zh_cn)
      const baseEntries = pair.base.zhCn?.entries ?? {};
      const headEntries = pair.head.zhCn?.entries ?? {};
      const diffResult = diffLangEntries(baseEntries, headEntries);
      const changedRows = filterChangedRows(diffResult.rows);

      // Apply cursor pagination
      const pageRows = changedRows.slice(pageStart, pageStart + cappedPageSize);
      const hasMore = pageStart + pageRows.length < changedRows.length;
      const nextCursor = hasMore ? encodeCursor(pageStart + pageRows.length) : null;

      // Build stats from full diff (not just page)
      const stats = computeStats(diffResult.rows);

      modResults.push({
        slug,
        gameVersion,
        modDomain,
        stats: {
          added: stats.added,
          removed: stats.removed,
          modified: stats.modified,
          unchanged: stats.unchanged,
        },
        rows: pageRows.map((r: DiffRow) => ({
          key: r.key,
          baseEn: r.oldEnglish ?? "",
          headEn: r.newEnglish ?? "",
          baseCn: r.oldChinese ?? "",
          headCn: r.newChinese ?? "",
          status: r.status,
        })),
        hasMore,
        nextCursor,
      });
    }

    return {
      headSha: resolvedHeadSha,
      baseSha,
      mods: modResults,
      totalMods: langResult.pairs.length,
      errors: langResult.errors.map((e) => ({
        modPath: e.modPath,
        message: e.message,
      })),
    };
  },
};
