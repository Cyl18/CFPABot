// src/flows/info-comment/_internal/collect-translation-diff.ts
// Collector: summarize translation changes in the PR.
// Uses collectLanguagePairs() and diffLangEntries() from shared internals.
// Returns SectionResult<TranslationDiffSummary> — pure summary, no Markdown.

import type { FlowContext } from "@/types.js";
import type { SectionResult, TranslationDiffSummary } from "../../_shared/types.js";
import { hashInputs } from "../state.js";
import { loadPrDiff, collectLanguagePairs } from "../../_internal/index.js";
import { diffLangEntries, filterChangedRows } from "../../_shared/language/index.js";

/**
 * Collect translation diff summary for the PR.
 *
 * 1. Load PR diff to get changed file paths.
 * 2. Use collectLanguagePairs() to get base/head language file pairs.
 * 3. Diff each pair's zh_cn (Chinese) entries between base and head.
 * 4. Aggregate stats across all pairs.
 * 5. Returns summary with counts and compare URL.
 *
 * Per-pair errors don't fail the whole section — errored pairs are skipped.
 */
export async function collectTranslationDiff(
  ctx: FlowContext,
  prNumber: number,
  headSha: string,
  baseSha: string,
): Promise<SectionResult<TranslationDiffSummary>> {
  const inputHash = hashInputs(String(prNumber), headSha, baseSha);

  let diff;
  try {
    diff = await loadPrDiff(ctx, { prNumber, expectedHeadSha: headSha, maxFiles: 5000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error: {
        code: "DIFF_LOAD_FAILED",
        publicMessage: `无法获取 PR #${prNumber} 的文件变更以分析翻译`,
        retryable: true,
      },
      inputHash,
    };
  }

  const changedFiles = diff.files;

  // Filter to language-related files only
  const langFiles = changedFiles.filter(
    (f) => /\.(json|lang)$/.test(f.filename) && f.status !== "removed",
  );

  if (langFiles.length === 0) {
    return {
      status: "empty",
      inputHash,
    };
  }

  // Collect language pairs
  let pairs;
  try {
    pairs = await collectLanguagePairs(ctx, baseSha, headSha, changedFiles);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error: {
        code: "LANG_PAIR_COLLECT_FAILED",
        publicMessage: `无法收集 PR #${prNumber} 的语言文件对比数据`,
        retryable: true,
      },
      inputHash,
    };
  }

  // Diff each pair's zh_cn between base and head, aggregate
  let totalPairCount = 0;
  let totalModified = 0;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const pair of pairs.pairs) {
    const baseZh = pair.base.zhCn;
    const headZh = pair.head.zhCn;

    // Need both base and head Chinese files to diff
    if (!baseZh || !headZh) continue;

    // Only count pairs where both Chinese files parsed cleanly
    if (baseZh.errors.length > 0 || headZh.errors.length > 0) continue;

    totalPairCount++;

    const diffResult = diffLangEntries(baseZh.entries, headZh.entries);
    const changed = filterChangedRows(diffResult.rows);

    for (const row of changed) {
      switch (row.status) {
        case "new":
          totalAdded++;
          break;
        case "modified":
          totalModified++;
          break;
        case "removed":
          totalRemoved++;
          break;
      }
    }
  }

  // Build compare URL
  const compareUrl = `https://github.com/${ctx.repo.owner}/${ctx.repo.name}/compare/${baseSha}...${headSha}`;

  if (totalPairCount === 0) {
    return {
      status: "empty",
      inputHash,
    };
  }

  return {
    status: "ready",
    data: {
      pairCount: totalPairCount,
      modifiedCount: totalModified,
      addedCount: totalAdded,
      removedCount: totalRemoved,
      compareUrl,
    },
    inputHash,
  };
}
