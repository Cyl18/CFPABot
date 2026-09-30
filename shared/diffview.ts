export type DiffLaneRole = "ref" | "real" | "extra";

export interface DiffLane {
  id: string;
  label: string;
  role: DiffLaneRole;
  highlight?: boolean;
  title?: string;
  zhFile?: boolean;
  skipZh?: boolean;
  absent?: boolean;
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

export type DiffFacet = "changed" | "en" | "zhAny" | "add" | "remove" | "partial" | "untranslated" | "extra";

/** 每个开关：true 只看，false 排除，没写就是不限。 */
export type DiffFilterState = Partial<Record<DiffFacet, boolean>>;

export const DIFF_FACETS: readonly DiffFacet[] = ["changed", "en", "zhAny", "add", "remove", "partial", "untranslated", "extra"];

export const DEFAULT_DIFF_FILTER: DiffFilterState = { changed: true };

export interface DiffFacts {
  missing: "add" | "remove" | "partial" | null;
  en: boolean;
  zhAny: boolean;
  zh: boolean;
  stale: boolean;
  untranslated: boolean;
  extra: boolean;
  differs: boolean;
}

export function diffFacts(entry: DiffEntry, lanes: readonly DiffLane[]): DiffFacts {
  const core = lanes.filter((lane) => lane.role !== "extra");
  const extra = lanes.find((lane) => lane.role === "extra") ?? null;
  const present = core.filter((lane) => entry.cells[lane.id] != null);
  const first = core[0];
  const last = core[core.length - 1];
  const missing =
    first === undefined || present.length === 0 || present.length === core.length
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

  const jar = extra === null ? null : (entry.cells[extra.id] ?? null);
  const peer = last === undefined ? null : (entry.cells[last.id] ?? null);
  const extraMismatch = extra !== null && ((jar === null) !== (peer === null) || (jar !== null && peer !== null && jar.en !== peer.en));

  return {
    missing,
    en,
    zhAny,
    zh: [...zhByEn.values()].some((values) => values.size > 1),
    stale: [...enByZh.values()].some((sources) => sources.size > 1),
    untranslated,
    extra: extraMismatch,
    differs: en || zhAny,
  };
}

export const FACET_MATCH: Record<DiffFacet, (facts: DiffFacts) => boolean> = {
  changed: (facts) => facts.differs || facts.missing === "add" || facts.missing === "remove",
  en: (facts) => facts.en,
  zhAny: (facts) => facts.zhAny,
  add: (facts) => facts.missing === "add",
  remove: (facts) => facts.missing === "remove",
  partial: (facts) => facts.missing === "partial",
  untranslated: (facts) => facts.untranslated,
  extra: (facts) => facts.extra,
};

export function matchesFilter(facts: DiffFacts, state: DiffFilterState): boolean {
  return DIFF_FACETS.every((facet) => state[facet] === undefined || FACET_MATCH[facet](facts) === state[facet]);
}

function encodeFilter(state: DiffFilterState): string {
  const tokens = DIFF_FACETS.flatMap((facet) => (state[facet] === undefined ? [] : [`${state[facet] === true ? "" : "-"}${facet}`]));
  return tokens.length === 0 ? "all" : tokens.join(",");
}

export function parseDiffFilter(raw: string | undefined): DiffFilterState {
  if (raw === undefined) return DEFAULT_DIFF_FILTER;
  const state: DiffFilterState = {};
  for (const token of raw.split(",")) {
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
