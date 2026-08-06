// src/flows/_shared/language/lang-differ.ts
// PURE: Compute diffs between two language file content maps.
// No I/O, no globals, no side effects.

import type { DiffRow } from "../types.js";
import type { LangDiffResult, LangDiffStats } from "../types.js";
import { parseLangFile } from "./lang-file.js";
import type { LanguageFileFormat } from "../types.js";

/**
 * Compute diff rows between old (base) and new (head) language file content strings.
 * Both must be in the same format.
 */
export function diffLangFiles(
  oldContent: string,
  newContent: string,
  format: LanguageFileFormat,
): LangDiffResult {
  const oldResult = parseLangFile(oldContent, format);
  const newResult = parseLangFile(newContent, format);

  return diffLangEntries(oldResult.entries, newResult.entries);
}

/**
 * Compute diff rows between old and new entry maps.
 * Pure: no parsing, works on already-parsed entries.
 */
export function diffLangEntries(
  oldEntries: Record<string, string>,
  newEntries: Record<string, string>,
): LangDiffResult {
  const rows: DiffRow[] = [];
  const allKeys = new Set([
    ...Object.keys(oldEntries),
    ...Object.keys(newEntries),
  ]);

  for (const key of allKeys) {
    const oldVal = oldEntries[key];
    const newVal = newEntries[key];

    if (oldVal === undefined) {
      // Added
      rows.push({
        key,
        oldEnglish: "",
        newEnglish: "",
        oldChinese: "",
        newChinese: newVal ?? "",
        status: "new",
        termCheck: "ok",
      });
    } else if (newVal === undefined) {
      // Removed
      rows.push({
        key,
        oldEnglish: "",
        newEnglish: "",
        oldChinese: oldVal,
        newChinese: "",
        status: "removed",
        termCheck: "ok",
      });
    } else if (oldVal !== newVal) {
      // Modified
      rows.push({
        key,
        oldEnglish: "",
        newEnglish: "",
        oldChinese: oldVal,
        newChinese: newVal,
        status: "modified",
        termCheck: "ok",
      });
    } else {
      // Unchanged
      rows.push({
        key,
        oldEnglish: "",
        newEnglish: "",
        oldChinese: oldVal,
        newChinese: newVal,
        status: "unchanged",
        termCheck: "ok",
      });
    }
  }

  return {
    rows,
    stats: computeStats(rows),
  };
}

/**
 * Compute statistics from a list of diff rows.
 */
export function computeStats(rows: DiffRow[]): LangDiffStats {
  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  for (const row of rows) {
    switch (row.status) {
      case "new":
        added++;
        break;
      case "removed":
        removed++;
        break;
      case "modified":
        modified++;
        break;
      case "unchanged":
        unchanged++;
        break;
    }
  }

  return { added, removed, modified, unchanged };
}

/**
 * Filter out unchanged rows from a diff result.
 */
export function filterChangedRows(rows: DiffRow[]): DiffRow[] {
  return rows.filter((r) => r.status !== "unchanged");
}

/**
 * Determine the dominant change type across a set of diff rows.
 * When multiple types tie for the highest count, returns "mixed".
 */
export function dominantChangeType(
  stats: LangDiffStats,
): "new" | "modified" | "removed" | "mixed" | "none" {
  if (stats.added === 0 && stats.removed === 0 && stats.modified === 0) {
    return "none";
  }

  const max = Math.max(stats.added, stats.removed, stats.modified);

  // Count how many types tie for the max
  let tieCount = 0;
  if (stats.added === max) tieCount++;
  if (stats.removed === max) tieCount++;
  if (stats.modified === max) tieCount++;

  if (tieCount > 1) return "mixed";

  if (max === stats.added) return "new";
  if (max === stats.removed) return "removed";
  return "modified";
}
