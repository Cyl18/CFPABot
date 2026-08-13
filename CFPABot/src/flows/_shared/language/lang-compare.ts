// src/flows/_shared/language/lang-compare.ts
// PURE: Diff two translation entry maps into DiffRow[] + summary.
import type { DiffRow } from "../types.js";

/** Diff two entry maps into DiffRow[] + summary. */
export function diffCompareMaps(
  mapA: Record<string, string>,
  mapB: Record<string, string>,
  isAZh: boolean,
): { rows: DiffRow[]; summary: { total: number; new: number; modified: number; removed: number; unchanged: number } } {
  const englishMap = isAZh ? mapB : mapA;
  const chineseMap = isAZh ? mapA : mapB;
  const allKeys = [...new Set([...Object.keys(mapA), ...Object.keys(mapB)])].sort((a, b) => a.localeCompare(b));
  const rows: DiffRow[] = [];
  let add = 0, mod = 0, rem = 0, unc = 0;
  for (const key of allKeys) {
    const inA = key in mapA;
    const inB = key in mapB;
    const enVal = englishMap[key] ?? "";
    const chVal = chineseMap[key] ?? "";
    let status: "new" | "modified" | "removed" | "unchanged";
    if (!inA && inB) { status = "new"; add++; }
    else if (inA && !inB) { status = "removed"; rem++; }
    else if (mapA[key] !== mapB[key]) { status = "modified"; mod++; }
    else { status = "unchanged"; unc++; }
    rows.push({ key, oldEnglish: enVal, newEnglish: enVal, oldChinese: chVal, newChinese: chVal, status, termCheck: "ok" as const });
  }
  return { rows, summary: { total: rows.length, new: add, modified: mod, removed: rem, unchanged: unc } };
}
