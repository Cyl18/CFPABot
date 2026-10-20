export type DiffLaneRole = "ref" | "real";

export interface DiffLane {
  id: string;
  label: string;
  role: DiffLaneRole;
  highlight?: boolean;
  title?: string;
  zhFile?: boolean;
  skipZh?: boolean;
  absent?: boolean;
  consensus?: boolean;
  whole?: "insert" | "delete";
}

export interface DiffCell {
  en: string;
  zh: string | null;
}

export interface DiffEntry {
  key: string;
  touched?: boolean;
  cells: Record<string, DiffCell | null>;
}

export type DiffFacet = "changed" | "en" | "zhAny" | "add" | "remove" | "partial" | "untranslated" | "comments";

/** 能从 facts 判定的开关；「有评论」要看评论数据，由视图层补。 */
export type DiffFactFacet = Exclude<DiffFacet, "comments">;

/** 多个「只看」之间：and 同时满足，or 满足其一。「排除」永远与结果相与。 */
export type DiffCombine = "and" | "or";

/** 每个开关：true 只看，false 排除，没写就是不限。 */
export type DiffFilterState = Partial<Record<DiffFacet, boolean>> & { combine?: DiffCombine };

export const DIFF_FACETS: readonly DiffFacet[] = ["changed", "en", "zhAny", "add", "remove", "partial", "untranslated", "comments"];

export const DEFAULT_DIFF_FILTER: DiffFilterState = { changed: true };

export interface DiffFacts {
  missing: "add" | "remove" | "partial" | null;
  en: boolean;
  zhAny: boolean;
  zh: boolean;
  stale: boolean;
  untranslated: boolean;
  differs: boolean;
}

export function diffFacts(entry: DiffEntry, lanes: readonly DiffLane[]): DiffFacts {
  const present = lanes.filter((lane) => entry.cells[lane.id] != null);
  const first = lanes[0];
  const missing =
    first === undefined || present.length === 0 || present.length === lanes.length
      ? null
      : first.role === "ref"
        ? entry.cells[first.id] != null
          ? "remove"
          : "add"
        : "partial";

  const en = new Set(present.map((lane) => entry.cells[lane.id]!.en)).size > 1;
  const zhLanes = present.filter((lane) => lane.skipZh !== true);
  const zhAny = new Set(zhLanes.map((lane) => entry.cells[lane.id]!.zh)).size > 1;

  const zhByEn = new Map<string, Set<string>>();
  const enByZh = new Map<string, Set<string>>();
  for (const lane of zhLanes) {
    const cell = entry.cells[lane.id]!;
    if (cell.zh === null) continue;
    const values = zhByEn.get(cell.en) ?? new Set<string>();
    values.add(cell.zh);
    zhByEn.set(cell.en, values);
    const sources = enByZh.get(cell.zh) ?? new Set<string>();
    sources.add(cell.en);
    enByZh.set(cell.zh, sources);
  }

  const untranslated = present.some((lane) => {
    if (lane.role !== "real" || lane.zhFile === false) return false;
    const cell = entry.cells[lane.id]!;
    return cell.en.trim() !== "" && (cell.zh ?? "").trim() === "";
  });

  return {
    missing,
    en,
    zhAny,
    zh: [...zhByEn.values()].some((values) => values.size > 1),
    stale: [...enByZh.values()].some((sources) => sources.size > 1),
    untranslated,
    differs: en || zhAny,
  };
}

export const FACET_MATCH: Record<DiffFactFacet, (facts: DiffFacts) => boolean> = {
  changed: (facts) => facts.differs || facts.missing === "add" || facts.missing === "remove",
  en: (facts) => facts.en,
  zhAny: (facts) => facts.zhAny,
  add: (facts) => facts.missing === "add",
  remove: (facts) => facts.missing === "remove",
  partial: (facts) => facts.missing === "partial",
  untranslated: (facts) => facts.untranslated,
};

/** 每个开关是否命中由调用方给出：facts 之外的开关（如「有评论」）还要额外数据。 */
export function matchesFilter(match: (facet: DiffFacet) => boolean, state: DiffFilterState): boolean {
  const only: DiffFacet[] = [];
  for (const facet of DIFF_FACETS) {
    const want = state[facet];
    if (want === undefined) continue;
    if (want === false) {
      if (match(facet)) return false;
    } else {
      only.push(facet);
    }
  }
  if (only.length === 0) return true;
  return state.combine === "or" ? only.some((facet) => match(facet)) : only.every((facet) => match(facet));
}

function encodeFilter(state: DiffFilterState): string {
  const tokens = DIFF_FACETS.flatMap((facet) => (state[facet] === undefined ? [] : [`${state[facet] === true ? "" : "-"}${facet}`]));
  if (state.combine === "or") tokens.unshift("or");
  return tokens.length === 0 ? "all" : tokens.join(",");
}

export function parseDiffFilter(raw: string | undefined): DiffFilterState {
  if (raw === undefined) return DEFAULT_DIFF_FILTER;
  const state: DiffFilterState = {};
  for (const token of raw.split(",")) {
    if (token === "or") {
      state.combine = "or";
      continue;
    }
    const negated = token.startsWith("-");
    const facet = (negated ? token.slice(1) : token) as DiffFacet;
    if (DIFF_FACETS.includes(facet)) state[facet] = !negated;
  }
  return state;
}

/** 默认状态不写进 URL。 */
export function formatDiffFilter(state: DiffFilterState): string | undefined {
  const raw = encodeFilter(state);
  return raw === encodeFilter(DEFAULT_DIFF_FILTER) ? undefined : raw;
}

export function matchesQuery(entry: DiffEntry, lanes: readonly DiffLane[], needle: string): boolean {
  if (needle === "") return true;
  if (entry.key.toLowerCase().includes(needle)) return true;
  return lanes.some((lane) => {
    const cell = entry.cells[lane.id];
    return cell != null && (cell.en.toLowerCase().includes(needle) || (cell.zh ?? "").toLowerCase().includes(needle));
  });
}
