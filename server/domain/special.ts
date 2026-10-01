import type { PrFile, SpecialPair, SpecialSide } from "../../shared/api.ts";

export interface SpecialToken {
  start: number;
  end: number;
  text: string;
  lang: "en" | "zh";
}

export interface PlannedSide {
  path: string;
  file: PrFile | null;
  alternate?: string;
}

export type SpecialPlan =
  | { key: string; kind: "pair"; en: PlannedSide; zh: PlannedSide }
  | { key: string; kind: "single"; file: PlannedSide };

const LONG_TOKEN = /en[_-]?us|zh[_-]?cn/gi;
const SHORT_TOKEN = /en|zh/gi;
const SEPARATOR = /[/_.-]/;
const EN_LETTERS = "enus";
const ZH_LETTERS = "zhcn";

function tokenLang(text: string): "en" | "zh" {
  return text.charAt(0).toLowerCase() === "e" ? "en" : "zh";
}

function isEdge(path: string, index: number): boolean {
  return index < 0 || index >= path.length || SEPARATOR.test(path.charAt(index));
}

function isSegmentEdge(path: string, index: number): boolean {
  return index < 0 || index >= path.length || path.charAt(index) === "/";
}

function scan(path: string, pattern: RegExp, accept: (start: number, end: number) => boolean): SpecialToken[] {
  const tokens: SpecialToken[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(path); match !== null; match = pattern.exec(path)) {
    const start = match.index;
    const end = start + match[0].length;
    if (accept(start, end)) tokens.push({ start, end, text: match[0], lang: tokenLang(match[0]) });
  }
  return tokens;
}

export function specialTokens(path: string): SpecialToken[] {
  const found = [
    ...scan(path, LONG_TOKEN, (start, end) => isEdge(path, start - 1) && isEdge(path, end)),
    ...scan(
      path,
      SHORT_TOKEN,
      (start, end) =>
        (isSegmentEdge(path, start - 1) && isSegmentEdge(path, end)) ||
        (isEdge(path, start - 1) && path.charAt(end) === "." && !path.slice(end).includes("/")),
    ),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const tokens: SpecialToken[] = [];
  for (const token of found) {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && token.start < last.end) continue;
    tokens.push(token);
  }
  return tokens;
}

function replaceTokens(path: string, tokens: readonly SpecialToken[], replacement: (token: SpecialToken) => string): string {
  if (tokens.length === 0) return path;
  let result = "";
  let pos = 0;
  for (const token of tokens) {
    result += path.slice(pos, token.start) + replacement(token);
    pos = token.end;
  }
  return result + path.slice(pos);
}

// 语言段连同把它和路径粘在一起的那个分隔符一起去掉，`guide/_zh_cn/x.md` 才会和 `guide/x.md` 落到同一组。
function cutRange(path: string, token: SpecialToken): [number, number] {
  let from = token.start;
  let to = token.end;
  const before = path.charAt(from - 1);
  const after = path.charAt(to);
  if (before === "_" || before === "-" || before === ".") from -= 1;
  else if (after === "" && before === "/") from -= 1;
  if (after === "/") to += 1;
  return [from, to];
}

export function specialKey(path: string): string {
  const tokens = specialTokens(path);
  if (tokens.length === 0) return path;
  let result = "";
  let pos = 0;
  for (const token of tokens) {
    const [from, to] = cutRange(path, token);
    result += path.slice(pos, from);
    pos = to;
  }
  return result + path.slice(pos);
}

function swapToken(text: string): string {
  const target = tokenLang(text) === "en" ? ZH_LETTERS : EN_LETTERS;
  let result = "";
  let index = 0;
  for (const char of text) {
    const lower = char.toLowerCase();
    if (lower === "_" || lower === "-") {
      result += char;
      continue;
    }
    const mapped = target.charAt(index);
    index += 1;
    result += char === lower ? mapped : mapped.toUpperCase();
  }
  return result;
}

export function counterpartPath(path: string): string {
  return replaceTokens(path, specialTokens(path), (token) => swapToken(token.text));
}

// 语言目录有两种写法：`_zh_cn` 这类覆盖目录的原文就在基础路径上，`zh_cn` 这类同级目录的原文在同结构的另一侧。两个候选都留着，最后看仓库里哪个真的存在。
function counterpartCandidates(path: string, key: string): [string, string] {
  const override = specialTokens(path).some((token) => {
    const before = path.charAt(token.start - 1);
    return before === "_" || before === "-" || before === ".";
  });
  const swapped = counterpartPath(path);
  return override ? [key, swapped] : [swapped, key];
}

function preferred(candidates: readonly PrFile[], others: readonly PrFile[]): PrFile | null {
  const match = candidates.find((file) => others.some((other) => counterpartPath(file.path) === other.path));
  return match ?? candidates[0] ?? null;
}

export function planSpecial(files: readonly PrFile[]): SpecialPlan[] {
  const groups = new Map<string, { en: PrFile[]; zh: PrFile[]; plain: PrFile[] }>();
  for (const file of files) {
    const langs = new Set(specialTokens(file.path).map((token) => token.lang));
    const key = specialKey(file.path);
    const group = groups.get(key) ?? { en: [], zh: [], plain: [] };
    const bucket = langs.size === 1 ? (langs.has("en") ? group.en : group.zh) : group.plain;
    bucket.push(file);
    groups.set(key, group);
  }

  const entries = new Map<string, SpecialPlan>();
  for (const [key, group] of groups) {
    // 不带语言段的那个文件就是默认语言（英文）原文，译文放在语言目录里。
    const en = preferred(group.en, group.zh) ?? preferred(group.plain, group.zh);
    const zh = preferred(group.zh, group.en);
    if (en === null && zh === null) continue;
    if (en !== null && zh !== null) {
      entries.set(key, { key, kind: "pair", en: { path: en.path, file: en }, zh: { path: zh.path, file: zh } });
      continue;
    }
    if (zh !== null) {
      const [path, alternate] = counterpartCandidates(zh.path, key);
      entries.set(key, { key, kind: "pair", en: { path, file: null, alternate }, zh: { path: zh.path, file: zh } });
      continue;
    }
    const present = en as PrFile;
    if (specialTokens(present.path).length === 0) {
      entries.set(key, { key, kind: "single", file: { path: present.path, file: present } });
      continue;
    }
    const [path, alternate] = counterpartCandidates(present.path, key);
    entries.set(key, { key, kind: "pair", en: { path: present.path, file: present }, zh: { path, file: null, alternate } });
  }
  return [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function resolveDerived(plans: readonly SpecialPlan[], existing: ReadonlySet<string>): SpecialPlan[] {
  const pick = (side: PlannedSide): PlannedSide =>
    side.file === null && side.alternate !== undefined && !existing.has(side.path) && existing.has(side.alternate)
      ? { path: side.alternate, file: null }
      : side;
  return plans.map((plan) => (plan.kind === "single" ? plan : { ...plan, en: pick(plan.en), zh: pick(plan.zh) }));
}

export function resolveSpecial(plans: readonly SpecialPlan[], existing: ReadonlySet<string>): SpecialPair[] {
  const sideOf = (side: PlannedSide): SpecialSide =>
    side.file === null
      ? { path: side.path, status: existing.has(side.path) ? "unchanged" : "missing" }
      : {
          path: side.path,
          status: side.file.status,
          ...(side.file.previousPath === undefined ? {} : { previousPath: side.file.previousPath }),
        };
  return plans.map((plan) =>
    plan.kind === "single"
      ? { key: plan.key, kind: "single", file: sideOf(plan.file) }
      : { key: plan.key, kind: "pair", en: sideOf(plan.en), zh: sideOf(plan.zh) },
  );
}
