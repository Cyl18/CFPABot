import { extname } from "node:path";
import type { PrFile, SpecialPair, SpecialSide } from "@cfpa/contracts/api";
import { specialFormat } from "./flatten.ts";
import { parseLangPath } from "@cfpa/review-core/domain/path";

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

const BINARY_EXT: Record<string, true> = {
  ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".ico": true, ".bmp": true,
  ".dds": true, ".tga": true, ".psd": true, ".ogg": true, ".wav": true, ".mp3": true, ".mp4": true,
  ".webm": true, ".zip": true, ".jar": true, ".7z": true, ".rar": true, ".gz": true, ".class": true,
  ".ttf": true, ".otf": true, ".woff": true, ".woff2": true, ".nbt": true, ".mca": true, ".mcr": true,
  ".bin": true, ".exe": true, ".dll": true, ".so": true, ".dylib": true, ".pdf": true, ".sqlite": true,
};
const ASSET_PATH = /^projects\/(?:assets\/|\d[^/]*\/assets\/)/;
const README_FILE = /^readme(\.[a-z0-9]+)?$/i;
const MANUAL_SEGMENT = /(^|\/)_?(zh_cn|en_us)(\/|$)/i;

// 只认模组资源目录：新布局 projects/assets/<模组>/<版本>/、旧布局 projects/<版本>/assets/<模组>/；仓库工具链和 README 占位说明不是译文内容。
export function isSpecialPath(path: string): boolean {
  if (!ASSET_PATH.test(path)) return false;
  if (parseLangPath(path)) return false;
  if (BINARY_EXT[extname(path).toLowerCase()]) return false;
  if (README_FILE.test(path.slice(path.lastIndexOf("/") + 1))) return false;
  // .flatten.json5 是模组语言源文件，语言词元在文件名里而不是路径段里。
  if (path.endsWith(".json5")) return true;
  if (path.endsWith(".json") || path.endsWith(".lang") || path.includes("/lang/")) return MANUAL_SEGMENT.test(path);
  return true;
}

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

// 覆盖目录的原文在基础路径，同级目录的原文在另一侧；两个候选都留，最后看哪个真实存在。
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

export function specialStatusOf(
  side: PlannedSide,
  existing: ReadonlySet<string>,
  moved: ReadonlySet<string>,
): SpecialSide["status"] {
  if (side.file !== null) return side.file.status;
  if (moved.has(side.path)) return "removed";
  if (!existing.has(side.path)) return "missing";
  return "unchanged";
}

export function planAtHead(plan: SpecialPlan, existing: ReadonlySet<string>, moved: ReadonlySet<string>): boolean {
  const sides = plan.kind === "single" ? [plan.file] : [plan.en, plan.zh];
  return sides.some((side) => {
    const status = specialStatusOf(side, existing, moved);
    return status !== "removed" && status !== "missing";
  });
}

export function resolveSpecial(
  plans: readonly SpecialPlan[],
  existing: ReadonlySet<string>,
  moved: ReadonlySet<string> = new Set(),
): SpecialPair[] {
  const sideOf = (side: PlannedSide): SpecialSide =>
    side.file === null
      ? { path: side.path, status: specialStatusOf(side, existing, moved) }
      : {
          path: side.path,
          status: side.file.status,
          ...(side.file.previousPath === undefined ? {} : { previousPath: side.file.previousPath }),
        };
  return plans.map((plan) => {
    if (plan.kind === "single") {
      return { key: plan.key, kind: "single", parsedFormat: specialFormat(plan.file.path), file: sideOf(plan.file) };
    }
    const enFormat = specialFormat(plan.en.path);
    const zhFormat = specialFormat(plan.zh.path);
    const parsedFormat = enFormat !== null && enFormat === zhFormat ? enFormat : null;
    return { key: plan.key, kind: "pair", parsedFormat, en: sideOf(plan.en), zh: sideOf(plan.zh) };
  });
}
