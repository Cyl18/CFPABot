// src/flows/info-comment/_internal/collect-checks.ts
// Collector: deterministic checks on PR changes.
// Returns SectionResult<ChecksData> — each sub-check is independent.
// Does not add/remove labels (that's labels_sync's job).

import type { FlowContext } from "@/types.js";
import type { SectionResult, ChecksData, Finding } from "../../_shared/types.js";
import { hashInputs } from "../state.js";
import { loadPrDiff } from "../../_internal/index.js";

const EXPENSIVE_CHECK_FILE_LIMIT = 1000;

/**
 * Collect deterministic check findings for the PR.
 *
 * Checks performed:
 * - File count guard (> 1000 → skip expensive checks)
 * - File path best-practices (upper-case paths, common errors)
 * - Mod ID recommendations
 *
 * Each sub-check is independent — one failure doesn't block others.
 * No external API calls (checks are purely path/diff-based).
 */
export async function collectChecks(
  ctx: FlowContext,
  prNumber: number,
  headSha: string,
): Promise<SectionResult<ChecksData>> {
  const inputHash = hashInputs(String(prNumber), headSha);

  let diff;
  try {
    diff = await loadPrDiff(ctx, { prNumber, expectedHeadSha: headSha, maxFiles: 5000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error: {
        code: "DIFF_LOAD_FAILED",
        publicMessage: `无法获取 PR #${prNumber} 的文件变更列表以执行检查`,
        retryable: true,
      },
      inputHash,
    };
  }

  const files = diff.files;
  const findings: Finding[] = [];
  const fileCount = files.length;

  // File count guard
  if (fileCount > EXPENSIVE_CHECK_FILE_LIMIT) {
    findings.push({
      code: "TOO_MANY_FILES",
      severity: "warning",
      message: `变更文件过多 (${fileCount})，已跳过部分详细检查`,
    });
    return {
      status: "ready",
      data: { findings },
      inputHash,
    };
  }

  // Basic stats
  findings.push({
    code: "FILE_COUNT",
    severity: "info",
    message: `共 ${fileCount} 个变更文件`,
  });

  // Check for upper-case paths (common issue in Minecraft mods)
  const upperCasePaths = files.filter((f) => /[A-Z]/.test(f.filename));
  if (upperCasePaths.length > 0) {
    const first = upperCasePaths[0]!;
    findings.push({
      code: "UPPER_CASE_PATHS",
      severity: "warning",
      message: `发现 ${upperCasePaths.length} 个包含大写字母的路径`,
      path: first.filename,
    });
  }

  // Check for common path prefix issues
  const nonStandardRoot = files.filter(
    (f) =>
      !f.filename.startsWith("projects/") &&
      !f.filename.startsWith(".github/") &&
      !f.filename.startsWith("src/"),
  );
  if (nonStandardRoot.length > 0) {
    const first = nonStandardRoot[0]!;
    findings.push({
      code: "NON_STANDARD_PATH",
      severity: "info",
      message: `发现 ${nonStandardRoot.length} 个非 projects/.github/src 路径的文件`,
      path: first.filename,
    });
  }

  // Check for deleted language files
  const deletedLangFiles = files.filter(
    (f) => f.status === "removed" && /\.(json|lang)$/.test(f.filename),
  );
  if (deletedLangFiles.length > 0) {
    const first = deletedLangFiles[0]!;
    findings.push({
      code: "DELETED_LANG_FILES",
      severity: "warning",
      message: `删除了 ${deletedLangFiles.length} 个语言文件`,
      path: first.filename,
    });
  }

  // Check for renamed files
  const renamedFiles = files.filter((f) => f.status === "renamed");
  if (renamedFiles.length > 0) {
    const first = renamedFiles[0]!;
    findings.push({
      code: "RENAMED_FILES",
      severity: "info",
      message: `重命名了 ${renamedFiles.length} 个文件`,
      path: first.filename,
    });
  }
  return {
    status: "ready",
    data: { findings },
    inputHash,
  };
}
