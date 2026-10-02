import { parsePatch, type StructuredPatchHunk } from "diff";
import type {
  CompareRow,
  CrossVersionKeyCell,
  CrossVersionKeyRow,
  RowStatus,
  TextCompareResult,
} from "../../shared/api.ts";

export interface Hunk {
  start: number;
  end: number;
}

interface LangEntries {
  entries: Map<string, string>;
}

type LangPair = { en?: LangEntries | null; zh?: LangEntries | null };

export function withLiteralNewlines(entries: Map<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of entries ?? []) out.set(key, value.replaceAll("\n", "\\n"));
  return out;
}

function statusOf(from: Map<string, string>, to: Map<string, string>, key: string): RowStatus {
  const inFrom = from.has(key);
  const inTo = to.has(key);
  if (!inFrom && inTo) return "add";
  if (inFrom && !inTo) return "remove";
  return from.get(key) === to.get(key) ? "same" : "modify";
}

export function compareLang(base: LangPair, head: LangPair): CompareRow[] {
  const baseEn = withLiteralNewlines(base.en?.entries);
  const baseZh = withLiteralNewlines(base.zh?.entries);
  const headEn = withLiteralNewlines(head.en?.entries);
  const headZh = withLiteralNewlines(head.zh?.entries);

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
  const leftEntries = withLiteralNewlines(left);
  const rightEntries = withLiteralNewlines(right);
  const keys = [...new Set([...leftEntries.keys(), ...rightEntries.keys()])].sort();
  return keys.map((key) => {
    const l = leftEntries.get(key);
    const r = rightEntries.get(key);
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

export interface CrossVersionInput {
  version: string;
  en?: Map<string, string>;
  zh?: Map<string, string>;
  touched?: ReadonlySet<string>;
}

export function alignKeys(input: readonly CrossVersionInput[]): CrossVersionKeyRow[] {
  const entries = input.map((entry) => ({
    version: entry.version,
    ...(entry.en === undefined ? {} : { en: withLiteralNewlines(entry.en) }),
    ...(entry.zh === undefined ? {} : { zh: withLiteralNewlines(entry.zh) }),
    ...(entry.touched === undefined ? {} : { touched: entry.touched }),
  }));

  const keys = new Set<string>();
  for (const entry of entries) {
    for (const key of entry.en?.keys() ?? []) keys.add(key);
  }

  return [...keys].sort().map((key) => {
    const cells: CrossVersionKeyCell[] = [];
    let touched = false;
    for (const entry of entries) {
      const en = entry.en?.get(key);
      if (en === undefined || en === "") continue;
      const zh = entry.zh?.get(key);
      cells.push({ version: entry.version, en, zh: zh === undefined || zh === "" ? null : zh });
      if (entry.touched?.has(key) === true) touched = true;
    }
    return { key, touched, cells };
  });
}

function hunksOf(patch: string): StructuredPatchHunk[] {
  return parsePatch(patch.replace(/\r\n/g, "\n"))[0]?.hunks ?? [];
}

export function patchHunks(patch: string): Hunk[] {
  return hunksOf(patch).map((hunk) => ({ start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 }));
}

export function patchAddedLines(patch: string): { line: number; text: string }[] {
  const added: { line: number; text: string }[] = [];
  for (const hunk of hunksOf(patch)) {
    let line = hunk.newStart;
    for (const text of hunk.lines) {
      const head = text[0];
      if (head === "+") {
        added.push({ line, text: text.slice(1) });
        line++;
      } else if (head === " ") {
        line++;
      }
    }
  }
  return added;
}

export function patchKeptLines(patch: string): string[] {
  const out: string[] = [];
  for (const hunk of hunksOf(patch)) {
    for (const text of hunk.lines) {
      const head = text[0];
      if (head === "+" || head === " ") out.push(text.slice(1));
    }
  }
  return out;
}

export function inHunks(line: number, hunks: Hunk[]): boolean {
  return hunks.some((h) => line >= h.start && line <= h.end);
}
