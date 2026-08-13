// src/flows/files/_internal/format-files.ts
// Files-domain internal: format language files in a workspace.
// No Flow definition — used by files_format execute().

import { readFile, writeFile } from "node:fs/promises";
import { FlowError } from "../../_internal/types.js";
import { resolveWorkspacePath } from "../../_internal/workspace-path.js";
import { formatLanguage } from "../../_shared/language/index.js";
import type { LanguageFileFormat } from "../../_shared/types.js";

export interface FormatResult {
  path: string;
  formatted: boolean;
}

export interface FormatOutput {
  results: FormatResult[];
  skipped: number;
  failed: number;
}

/** Detect language file format from extension. */
function detectFormat(filePath: string): LanguageFileFormat {
  if (filePath.endsWith(".lang")) return "lang";
  return "json";
}

/**
 * Format all specified language files in a workspace.
 * Skips files that are already properly formatted.
 * Returns per-file results, skip count, and failure count.
 */
export async function formatLangFiles(
  handle: { dir: string },
  paths: string[],
  explicitFormat?: LanguageFileFormat,
): Promise<FormatOutput> {
  if (paths.length === 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "No paths provided for formatting",
      publicMessage: "At least one language file path must be specified.",
      retryable: false,
    });
  }

  const results: FormatResult[] = [];
  let skipped = 0;
  let failed = 0;

  for (const filePath of paths) {
    const absPath = resolveWorkspacePath(handle.dir, filePath);
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      results.push({ path: filePath, formatted: false });
      failed++;
      continue;
    }

    const format = explicitFormat ?? detectFormat(filePath);
    const result = formatLanguage(content, format);

    if (result.error) {
      results.push({ path: filePath, formatted: false });
      failed++;
      continue;
    }

    if (result.formatted === content) {
      results.push({ path: filePath, formatted: false });
      skipped++;
      continue;
    }

    try {
      await writeFile(absPath, result.formatted, "utf-8");
      results.push({ path: filePath, formatted: true });
    } catch {
      results.push({ path: filePath, formatted: false });
      failed++;
    }
  }

  return { results, skipped, failed };
}
