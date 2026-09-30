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

export type DiffFilter = "diff" | "en" | "zhAny" | "zh" | "stale" | "untranslated" | "missing" | "extra" | "all";

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

export const DIFF_FILTERS: readonly DiffFilter[] = ["diff", "en", "zhAny", "zh", "stale", "untranslated", "missing", "extra", "all"];

export function isDiffFilter(value: string | undefined): value is DiffFilter {
  return value !== undefined && (DIFF_FILTERS as readonly string[]).includes(value);
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
    differs: en || zhAny || missing === "add" || missing === "remove",
  };
}

export function matchesFilter(facts: DiffFacts, filter: DiffFilter): boolean {
  if (filter === "all") return true;
  if (filter === "diff") return facts.differs;
  if (filter === "missing") return facts.missing !== null;
  return facts[filter];
}

export function matchesQuery(entry: DiffEntry, lanes: readonly DiffLane[], needle: string): boolean {
  if (needle === "") return true;
  if (entry.key.toLowerCase().includes(needle)) return true;
  return lanes.some((lane) => {
    const cell = entry.cells[lane.id];
    return cell != null && (cell.en.toLowerCase().includes(needle) || (cell.zh ?? "").toLowerCase().includes(needle));
  });
}
