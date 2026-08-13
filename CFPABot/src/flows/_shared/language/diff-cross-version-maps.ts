// src/flows/_shared/language/diff-cross-version-maps.ts
// PURE: Cross-version consistency matrix for a fixed (slug, namespace) across
// all game versions discovered in the repo. Each version contributes an en+zh
// map (missing file => empty map). Rows = union of keys; per-key we compare
// non-empty EN / ZH values across versions and flag inconsistency.
//
// This is NOT a base/head binary diff. It is a multi-version matrix:
//   - enConsistent: all versions that DO have a non-empty EN value agree
//   - zhConsistent: same for ZH
//   - enSameZhDiffers: EN agrees but ZH differs (strong signal)
//   - a version where the key is absent is excluded from the consistency set
//     but still rendered with present=false (color-marked), not as a conflict
//
// No I/O, no globals, no side effects.

export interface CrossVersionCell {
  en: string;
  zh: string;
  /** True when key exists in this version's EN map with a non-empty value. */
  enPresent: boolean;
  /** True when key exists in this version's ZH map with a non-empty value. */
  zhPresent: boolean;
}

export interface CrossVersionRow {
  key: string;
  /** version label -> cell, keyed in the canonical version order. */
  versions: Record<string, CrossVersionCell>;
  enConsistent: boolean;
  zhConsistent: boolean;
  /** EN values agree across versions but ZH values differ — strong signal. */
  enSameZhDiffers: boolean;
  /** Number of versions where this key is present in either language. */
  presentCount: number;
  totalVersions: number;
}

export interface CrossVersionVersionSummary {
  total: number;
  enPresent: number;
  zhPresent: number;
}

export interface CrossVersionSummary {
  totalKeys: number;
  enConsistentKeys: number;
  zhConsistentKeys: number;
  enSameZhDiffersKeys: number;
  perVersion: Record<string, CrossVersionVersionSummary>;
}
export interface DiffCrossVersionMapsInput {
  /** Versions in canonical (display) order. Duplicates are not expected. */
  versions: Array<{
    version: string;
    en: Record<string, string>;
    zh: Record<string, string>;
  }>;
}

export interface DiffCrossVersionMapsResult {
  versions: string[];
  rows: CrossVersionRow[];
  summary: CrossVersionSummary;
}

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Union of all keys across every version's EN and ZH maps.
 */
function collectKeySet(
  versions: Array<{ en: Record<string, string>; zh: Record<string, string> }>,
): string[] {
  const set = new Set<string>();
  for (const v of versions) {
    for (const k of Object.keys(v.en)) set.add(k);
    for (const k of Object.keys(v.zh)) set.add(k);
  }
  return [...set].sort();
}

/**
 * Build the per-version matrix and consistency flags for one (slug, namespace)
 * across all versions. Pure: callers feed the resolved maps.
 */
export function diffCrossVersionMaps(
  input: DiffCrossVersionMapsInput,
): DiffCrossVersionMapsResult {
  const versions = input.versions.map((v) => v.version);
  const versionList = input.versions;
  const totalVersions = versionList.length;

  const keys = collectKeySet(versionList);

  // Per-version running counters for summary.
  const perVersionInit = () => ({
    total: 0,
    enPresent: 0,
    zhPresent: 0,
  });
  const perVersion: Record<string, CrossVersionVersionSummary> = {};
  for (const v of versionList) perVersion[v.version] = perVersionInit();

  const rows: CrossVersionRow[] = [];
  let enConsistentKeys = 0;
  let zhConsistentKeys = 0;
  let enSameZhDiffersKeys = 0;

  for (const key of keys) {
    const cells: Record<string, CrossVersionCell> = {};
    const enValues = new Set<string>();
    const zhValues = new Set<string>();
    let presentCount = 0;

    for (const v of versionList) {
      const enVal = v.en[key];
      const zhVal = v.zh[key];
      const enPresent = isNonEmpty(enVal);
      const zhPresent = isNonEmpty(zhVal);
      cells[v.version] = {
        en: enPresent ? enVal : "",
        zh: zhPresent ? zhVal : "",
        enPresent,
        zhPresent,
      };
      if (enPresent) {
        enValues.add(enVal);
        perVersion[v.version]!.enPresent++;
      }
      if (zhPresent) {
        zhValues.add(zhVal);
        perVersion[v.version]!.zhPresent++;
      }
      if (enPresent || zhPresent) {
        presentCount++;
        perVersion[v.version]!.total++;
      }
    }

    // Consistency: only meaningful when 2+ versions have a non-empty value.
    // 0 or 1 versions with a value => trivially consistent.
    const enConsistent = enValues.size <= 1;
    const zhConsistent = zhValues.size <= 1;
    // Strong signal: EN agrees (0 or 1 distinct non-empty values) but ZH has
    // 2+ distinct non-empty values. If both are empty everywhere it is false.
    const enSameZhDiffers = enConsistent && zhValues.size > 1;

    if (enConsistent) enConsistentKeys++;
    if (zhConsistent) zhConsistentKeys++;
    if (enSameZhDiffers) enSameZhDiffersKeys++;

    rows.push({
      key,
      versions: cells,
      enConsistent,
      zhConsistent,
      enSameZhDiffers,
      presentCount,
      totalVersions,
    });
  }

  return {
    versions,
    rows,
    summary: {
      totalKeys: keys.length,
      enConsistentKeys,
      zhConsistentKeys,
      enSameZhDiffersKeys,
      perVersion,
    },
  };
}
