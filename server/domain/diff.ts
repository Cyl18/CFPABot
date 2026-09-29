import type {
  CompareRow,
  CrossVersionCell,
  CrossVersionRow,
  RowStatus,
  TextCompareResult,
} from "../../shared/api.ts";
import type { ParsedLang } from "./langfile.ts";

export interface Hunk {
  start: number;
  end: number;
}

type LangPair = { en?: ParsedLang | null; zh?: ParsedLang | null };

function statusOf(from: Map<string, string>, to: Map<string, string>, key: string): RowStatus {
  const inFrom = from.has(key);
  const inTo = to.has(key);
  if (!inFrom && inTo) return "add";
  if (inFrom && !inTo) return "remove";
  return from.get(key) === to.get(key) ? "same" : "modify";
}

export function compareLang(base: LangPair, head: LangPair): CompareRow[] {
  const baseEn = base.en?.entries ?? new Map<string, string>();
  const baseZh = base.zh?.entries ?? new Map<string, string>();
  const headEn = head.en?.entries ?? new Map<string, string>();
  const headZh = head.zh?.entries ?? new Map<string, string>();

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of headEn.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  const rest = new Set<string>();
  for (const map of [baseEn, baseZh, headZh]) {
    for (const key of map.keys()) {
      if (!seen.has(key)) rest.add(key);
    }
  }
  keys.push(...[...rest].sort());

  return keys.map((key) => {
    const row: CompareRow = {
      key,
      enStatus: statusOf(baseEn, headEn, key),
      zhStatus: statusOf(baseZh, headZh, key),
    };
    const baseEnValue = baseEn.get(key);
    if (baseEnValue !== undefined) row.baseEn = baseEnValue;
    const headEnValue = headEn.get(key);
    if (headEnValue !== undefined) row.headEn = headEnValue;
    const baseZhValue = baseZh.get(key);
    if (baseZhValue !== undefined) row.baseZh = baseZhValue;
    const headZhValue = headZh.get(key);
    if (headZhValue !== undefined) row.headZh = headZhValue;
    return row;
  });
}

export function compareTwo(
  left: Map<string, string>,
  right: Map<string, string>,
): TextCompareResult["rows"] {
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  return keys.map((key) => {
    const l = left.get(key);
    const r = right.get(key);
    const status: RowStatus =
      l === undefined && r !== undefined
        ? "add"
        : l !== undefined && r === undefined
          ? "remove"
          : l === r
            ? "same"
            : "modify";
    return {
      key,
      ...(l !== undefined ? { left: l } : {}),
      ...(r !== undefined ? { right: r } : {}),
      status,
    };
  });
}

export function crossVersion(
  input: { version: string; en?: Map<string, string>; zh?: Map<string, string> }[],
): CrossVersionRow[] {
  const keys = new Set<string>();
  for (const entry of input) {
    for (const key of entry.en?.keys() ?? []) keys.add(key);
    for (const key of entry.zh?.keys() ?? []) keys.add(key);
  }

  return [...keys].sort().map((key) => {
    const cells: Record<string, CrossVersionCell> = {};
    const enValues = new Set<string>();
    const zhValues = new Set<string>();
    for (const entry of input) {
      const cell: CrossVersionCell = {};
      const en = entry.en?.get(key);
      if (en !== undefined && en !== "") {
        cell.en = en;
        enValues.add(en);
      }
      const zh = entry.zh?.get(key);
      if (zh !== undefined && zh !== "") {
        cell.zh = zh;
        zhValues.add(zh);
      }
      cells[entry.version] = cell;
    }
    return {
      key,
      cells,
      enConsistent: enValues.size <= 1,
      zhConsistent: zhValues.size <= 1,
    };
  });
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function patchHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of patch.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    hunks.push({ start, end: start + count - 1 });
  }
  return hunks;
}

export function patchAddedLines(patch: string): { line: number; text: string }[] {
  const added: { line: number; text: string }[] = [];
  let current = -1;
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const m = HUNK_RE.exec(line);
    if (m) {
      current = Number(m[1]);
      continue;
    }
    if (current < 0) continue;
    const head = line[0];
    if (head === "+") {
      added.push({ line: current, text: line.slice(1) });
      current++;
    } else if (head === " ") {
      current++;
    }
  }
  return added;
}

export function inHunks(line: number, hunks: Hunk[]): boolean {
  return hunks.some((h) => line >= h.start && line <= h.end);
}
