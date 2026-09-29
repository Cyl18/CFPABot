import type {
  CompareRow,
  CrossVersionIssue,
  CrossVersionKeyCell,
  CrossVersionKeyRow,
  CrossVersionVariant,
  RowStatus,
  TextCompareResult,
} from "../../shared/api.ts";
import type { ParsedLang } from "./langfile.ts";

export interface Hunk {
  start: number;
  end: number;
}

type LangPair = { en?: ParsedLang | null; zh?: ParsedLang | null };

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

const KIND_ORDER: Record<CrossVersionIssue["kind"], number> = { conflict: 0, changed: 1, untranslated: 2 };

export function crossVersion(input: readonly CrossVersionInput[]): { keyCount: number; issues: CrossVersionIssue[] } {
  const entries = input.map((entry) => ({
    ...entry,
    ...(entry.en === undefined ? {} : { en: withLiteralNewlines(entry.en) }),
    ...(entry.zh === undefined ? {} : { zh: withLiteralNewlines(entry.zh) }),
  }));

  const keys = new Set<string>();
  for (const entry of entries) {
    for (const key of entry.en?.keys() ?? []) keys.add(key);
  }

  const issues: CrossVersionIssue[] = [];
  for (const key of keys) {
    const zhOf = (entry: CrossVersionInput) => {
      const raw = entry.zh?.get(key);
      return raw === undefined || raw === "" ? null : raw;
    };
    const byEn = new Map<string, CrossVersionInput[]>();
    for (const entry of entries) {
      const en = entry.en?.get(key);
      if (en === undefined || en === "") continue;
      const group = byEn.get(en) ?? [];
      group.push(entry);
      byEn.set(en, group);
    }

    if (byEn.size > 1) {
      const byPair = new Map<string, CrossVersionVariant>();
      for (const entry of entries) {
        const en = entry.en?.get(key);
        if (en === undefined || en === "") continue;
        const zh = zhOf(entry);
        const id = `${en}\u0000${zh ?? "\u0001"}`;
        const variant = byPair.get(id) ?? { en, zh, versions: [] };
        variant.versions.push(entry.version);
        byPair.set(id, variant);
      }
      const touched = entries.some((entry) => entry.touched?.has(key) === true && entry.en?.has(key) === true);
      issues.push({ key, kind: "changed", variants: [...byPair.values()], touched });
    }

    for (const [en, all] of byEn) {
      const group = all.filter((entry) => entry.zh !== undefined);
      if (group.length < 2) continue;
      const byZh = new Map<string | null, string[]>();
      for (const entry of group) {
        const zh = zhOf(entry);
        const list = byZh.get(zh) ?? [];
        list.push(entry.version);
        byZh.set(zh, list);
      }
      const translated = [...byZh.keys()].filter((zh) => zh !== null).length;
      const kind = translated >= 2 ? "conflict" : translated === 1 && byZh.has(null) ? "untranslated" : null;
      if (kind === null) continue;
      const variants: CrossVersionVariant[] = [...byZh].map(([zh, versions]) => ({ en, zh, versions }));
      variants.sort((a, b) => (a.zh === null ? 1 : 0) - (b.zh === null ? 1 : 0) || b.versions.length - a.versions.length);
      const touched = group.some((entry) => entry.touched?.has(key) === true);
      issues.push({ key, kind, variants, touched });
    }
  }

  issues.sort(
    (a, b) =>
      Number(b.touched) - Number(a.touched) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { keyCount: keys.size, issues };
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
