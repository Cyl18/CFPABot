// src/flows/_shared/language/diff-workspace-maps.ts
// PURE: Diff four translation maps (en/zh × old/new) into a workspace-aligned
// row list with per-language (en/zh) status. No I/O, no globals, no side effects.
//
// Status semantics per language (independent):
//   add        → key only in new
//   remove     → key only in old
//   modify     → key in both, values differ
//   unchanged  → key in both, values equal

export type WorkspaceStatus = "add" | "remove" | "modify" | "unchanged";

export interface CompareWorkspaceRow {
  key: string;
  oldEnglish: string;
  newEnglish: string;
  oldChinese: string;
  newChinese: string;
  /** English-only status for this key (derived from enOld ↔ enNew). */
  enStatus: WorkspaceStatus;
  /** Chinese-only status for this key (derived from zhOld ↔ zhNew). */
  zhStatus: WorkspaceStatus;
}

export interface WorkspaceSummary {
  total: number;
  en: { add: number; remove: number; modify: number; unchanged: number };
  zh: { add: number; remove: number; modify: number; unchanged: number };
}

export interface DiffWorkspaceMapsInput {
  enOld: Record<string, string>;
  enNew: Record<string, string>;
  zhOld: Record<string, string>;
  zhNew: Record<string, string>;
}

export interface DiffWorkspaceMapsResult {
  rows: CompareWorkspaceRow[];
  summary: WorkspaceSummary;
}


/**
 * Compute per-language status for a key present in old/new maps of one language.
 */
function statusFor(
  key: string,
  oldMap: Record<string, string>,
  newMap: Record<string, string>,
): WorkspaceStatus {
  const inOld = key in oldMap;
  const inNew = key in newMap;
  if (!inOld && inNew) return "add";
  if (inOld && !inNew) return "remove";
  if (oldMap[key] !== newMap[key]) return "modify";
  return "unchanged";
}

/**
 * Diff four translation maps (en/zh × base/head) into aligned rows with
 * independent en/zh status plus a summary counter.
 *
 * Alignment key = union of all four maps' keys, sorted by localeCompare.
 */
export function diffWorkspaceMaps(input: DiffWorkspaceMapsInput): DiffWorkspaceMapsResult {
  const { enOld, enNew, zhOld, zhNew } = input;

  const allKeys = [
    ...new Set([
      ...Object.keys(enOld),
      ...Object.keys(enNew),
      ...Object.keys(zhOld),
      ...Object.keys(zhNew),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  const rows: CompareWorkspaceRow[] = [];
  const summary: WorkspaceSummary = {
    total: 0,
    en: { add: 0, remove: 0, modify: 0, unchanged: 0 },
    zh: { add: 0, remove: 0, modify: 0, unchanged: 0 },
  };

  for (const key of allKeys) {
    const enStatus = statusFor(key, enOld, enNew);
    const zhStatus = statusFor(key, zhOld, zhNew);

    rows.push({
      key,
      oldEnglish: enOld[key] ?? "",
      newEnglish: enNew[key] ?? "",
      oldChinese: zhOld[key] ?? "",
      newChinese: zhNew[key] ?? "",
      enStatus,
      zhStatus,
    });

    summary.en[enStatus]++;
    summary.zh[zhStatus]++;
  }
  summary.total = rows.length;

  return { rows, summary };
}
