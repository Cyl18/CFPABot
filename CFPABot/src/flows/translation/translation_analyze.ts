// src/flows/translation/translation_analyze.ts
// Flow: translation_analyze — analyze translation changes in a PR: group by mod,
// detect added/modified/removed/untranslated keys, English changes without Chinese
// follow-up, and missing/unparseable language files.
// Risk: read | Effects: github_read
// Uses collectLanguagePairs() + shared alignLangReviewItems().

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { loadPrDiff, collectLanguagePairs } from "../_internal/index.js";
import { alignLangReviewItems } from "../_shared/language/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const translation_analyze_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  baseSha: Type.String({ description: "Base commit SHA" }),
  headSha: Type.String({ description: "Head commit SHA — fails STALE_HEAD if mismatch" }),
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Filter analysis to specific file paths" }),
  ),
});

export type TranslationAnalyzeInput = Static<typeof translation_analyze_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const translation_analyze_output = Type.Object({
  prNumber: Type.Number(),
  baseSha: Type.String(),
  headSha: Type.String(),
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
      newKeys: Type.Number(),
      removedKeys: Type.Number(),
      modifiedKeys: Type.Number(),
      untranslatedKeys: Type.Number(),
      enChangedNoCn: Type.Number(),
    }),
  ),
  globalStats: Type.Object({
    totalMods: Type.Number(),
    totalNew: Type.Number(),
    totalRemoved: Type.Number(),
    totalModified: Type.Number(),
    totalUntranslated: Type.Number(),
    totalEnChangedNoCn: Type.Number(),
  }),
  missingFiles: Type.Array(
    Type.Object({
      modPath: Type.String(),
      locale: Type.Union([Type.Literal("en_us"), Type.Literal("zh_cn")]),
    }),
  ),
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
  // Structured evidence aligned via alignLangReviewItems().
  // Optional fields distinguish missing key (undefined) from empty string ("").
  evidence: Type.Array(
    Type.Object({
      key: Type.String(),
      slug: Type.String(),
      type: Type.Union([
        Type.Literal("untranslated"),
        Type.Literal("en_changed"),
        Type.Literal("new_key"),
        Type.Literal("removed_key"),
        Type.Literal("modified"),
      ]),
      itemId: Type.String(),
      enBase: Type.Optional(Type.String()),
      enHead: Type.Optional(Type.String()),
      cnBase: Type.Optional(Type.String()),
      cnHead: Type.Optional(Type.String()),
    }),
  ),
});

export type TranslationAnalyzeOutput = Static<typeof translation_analyze_output>;

// ─── Helper ─────────────────────────────────────────────────────────────

function localeKey(pair: { slug: string; gameVersion: string; modDomain: string }): string {
  return `${pair.slug}/${pair.gameVersion}/${pair.modDomain}`;
}

// ─── Flow Definition ────────────────────────────────────────────────────

export const translation_analyze: Flow<typeof translation_analyze_input, typeof translation_analyze_output> = {
  name: "translation_analyze",
  description: "Analyze translation changes in a PR: group by mod, detect added/modified/removed/untranslated keys, English changes without Chinese follow-up, and missing/unparseable language files. Returns structured evidence suitable for ReviewDraft. Does not produce Markdown or publish comments.",
  input: translation_analyze_input,
  output: translation_analyze_output,
  meta: {
    tags: ["pr", "query", "review"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof translation_analyze_input>): Promise<Static<typeof translation_analyze_output>> {
    const { prNumber, baseSha, headSha, paths } = input;

    // 1. Load PR diff for changed files — validates headSha
    const prDiff = await loadPrDiff(ctx, {
      prNumber,
      expectedHeadSha: headSha,
      maxFiles: 1000,
      maxBytes: 5_000_000,
    });

    // Filter to specific paths if requested
    const changedFiles = paths
      ? prDiff.files.filter((f) => paths.some((p) => f.filename.startsWith(p)))
      : prDiff.files;

    // 2. Collect language pairs
    const langResult = await collectLanguagePairs(ctx, baseSha, headSha, changedFiles);

    // 3. Analyze each mod via shared alignLangReviewItems()
    const modResults: Array<{
      slug: string;
      gameVersion: string;
      modDomain: string;
      stats: { added: number; removed: number; modified: number; unchanged: number };
      newKeys: number;
      removedKeys: number;
      modifiedKeys: number;
      untranslatedKeys: number;
      enChangedNoCn: number;
    }> = [];
    const evidence: Array<{
      key: string;
      slug: string;
      type: "untranslated" | "en_changed" | "new_key" | "removed_key" | "modified";
      itemId: string;
      enBase?: string;
      enHead?: string;
      cnBase?: string;
      cnHead?: string;
    }> = [];
    const missingFiles: Array<{ modPath: string; locale: "en_us" | "zh_cn" }> = [];

    let totalNew = 0;
    let totalRemoved = 0;
    let totalModified = 0;
    let totalUntranslated = 0;
    let totalEnChangedNoCn = 0;

    for (const pair of langResult.pairs) {
      const { slug, gameVersion, modDomain } = pair.modPath;

      // Track missing files
      if (!pair.base.zhCn) {
        missingFiles.push({ modPath: localeKey(pair.modPath), locale: "zh_cn" });
      }
      if (!pair.base.enUs) {
        missingFiles.push({ modPath: localeKey(pair.modPath), locale: "en_us" });
      }
      if (!pair.head.zhCn) {
        missingFiles.push({ modPath: localeKey(pair.modPath), locale: "zh_cn" });
      }
      if (!pair.head.enUs) {
        missingFiles.push({ modPath: localeKey(pair.modPath), locale: "en_us" });
      }

      // Align four-value maps via shared pure function
      const result = alignLangReviewItems({
        baseEn: pair.base.enUs?.entries,
        headEn: pair.head.enUs?.entries,
        baseZh: pair.base.zhCn?.entries,
        headZh: pair.head.zhCn?.entries,
        mod: { slug, gameVersion, domain: modDomain },
        path: pair.canonicalPath,
        scope: {
          repoOwner: ctx.repo.owner,
          repoName: ctx.repo.name,
          prNumber: input.prNumber,
          headSha: input.headSha,
        },
      });

      // Index candidates by type for quick lookup
      const untranslatedItemIds = new Set<string>();
      const staleItemIds = new Set<string>();
      for (const c of result.candidates) {
        if (c.issueType === "untranslated_value") untranslatedItemIds.add(c.itemId);
        if (c.issueType === "stale_translation") staleItemIds.add(c.itemId);
      }

      // Count per-mod stats from aligned items + candidates
      let newKeys = 0;
      let modifiedKeys = 0;
      let removedKeys = 0;
      let untranslatedKeys = 0;
      let enChangedNoCn = 0;
      let zhAdded = 0;
      let zhRemoved = 0;
      let zhModified = 0;
      let zhUnchanged = 0;

      for (const item of result.items) {
        // Zh diff tracking for stats
        if (item.changed.zh) {
          if (item.baseZh === undefined) {
            zhAdded++;
          } else if (item.headZh === undefined) {
            zhRemoved++;
          } else {
            zhModified++;
          }
        } else if (item.baseZh !== undefined && item.headZh !== undefined) {
          zhUnchanged++;
        }

        // Evidence: zh change type
        if (item.changed.zh) {
          let evType: "new_key" | "removed_key" | "modified" | null = null;
          if (item.baseZh === undefined && item.headZh !== undefined) {
            evType = "new_key";
            newKeys++;
          } else if (item.baseZh !== undefined && item.headZh === undefined) {
            evType = "removed_key";
            removedKeys++;
          } else if (item.baseZh !== item.headZh) {
            evType = "modified";
            modifiedKeys++;
          }

          if (evType) {
            evidence.push({
              key: item.key,
              slug,
              type: evType,
              itemId: item.itemId,
              enBase: item.baseEn,
              enHead: item.headEn,
              cnBase: item.baseZh,
              cnHead: item.headZh,
            });
          }
        }

        // Evidence: untranslated
        if (untranslatedItemIds.has(item.itemId)) {
          untranslatedKeys++;
          evidence.push({
            key: item.key,
            slug,
            type: "untranslated",
            itemId: item.itemId,
            enBase: item.baseEn,
            enHead: item.headEn,
            cnBase: item.baseZh,
            cnHead: item.headZh,
          });
        }

        // Evidence: en_changed (stale translation)
        if (staleItemIds.has(item.itemId)) {
          enChangedNoCn++;
          evidence.push({
            key: item.key,
            slug,
            type: "en_changed",
            itemId: item.itemId,
            enBase: item.baseEn,
            enHead: item.headEn,
            cnBase: item.baseZh,
            cnHead: item.headZh,
          });
        }
      }

      modResults.push({
        slug,
        gameVersion,
        modDomain,
        stats: {
          added: zhAdded,
          removed: zhRemoved,
          modified: zhModified,
          unchanged: zhUnchanged,
        },
        newKeys,
        removedKeys,
        modifiedKeys,
        untranslatedKeys,
        enChangedNoCn,
      });

      totalNew += newKeys;
      totalRemoved += removedKeys;
      totalModified += modifiedKeys;
      totalUntranslated += untranslatedKeys;
      totalEnChangedNoCn += enChangedNoCn;
    }

    return {
      prNumber,
      baseSha,
      headSha,
      mods: modResults,
      globalStats: {
        totalMods: modResults.length,
        totalNew,
        totalRemoved,
        totalModified,
        totalUntranslated,
        totalEnChangedNoCn,
      },
      missingFiles,
      errors: langResult.errors.map((e) => ({
        modPath: e.modPath,
        message: e.message,
      })),
      evidence,
    };
  },
};
