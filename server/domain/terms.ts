import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { mcMatches } from "./path.ts";

export interface TermHit {
  en: string;
  zh: string[];
  ok: boolean;
  reason?: string;
  domain?: string;
}

export interface QaHit {
  id: string;
  ok: boolean;
  require?: string;
  forbid?: string;
  comment?: string;
}

interface TermRecord {
  en: string;
  zh: string[];
  reason?: string;
  domain?: string;
  versions?: string[];
  enRegex?: boolean;
  zhRegex?: boolean;
}

interface IndexEntry {
  en: string;
  zh: string[];
  reason?: string;
  domain?: string;
  versions?: string[];
  zhRegex?: boolean;
  enRe?: RegExp;
}

interface CompiledQa {
  id: string;
  keyRe?: RegExp;
  exceptKeyRe?: RegExp;
  enRe: RegExp;
  require?: string;
  forbid?: string;
  countMode: boolean;
  exceptEnRe?: RegExp;
  comment?: string;
}

export interface TermIndex {
  phrases: Map<string, IndexEntry[]>;
  regex: IndexEntry[];
  scopes: { domain: string; re: RegExp }[];
  qa: CompiledQa[];
  maxPhraseTokens: number;
  all: TermRecord[];
}

type Row = Record<string, string>;

function parseTsv(text: string, file: string): Row[] {
  const lines = text.split("\n");
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    throw new Error(`${file}: 空文件或缺表头`);
  }
  const header = headerLine.replace(/\r$/, "").split("\t").map((h) => h.trim());
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    if (line.trim() === "") continue;
    const cells = line.split("\t");
    if (cells.length < header.length) {
      throw new Error(`${file}:${i + 1}: 列数不足 (要 ${header.length} 得 ${cells.length})`);
    }
    const row: Row = {};
    for (let c = 0; c < header.length; c++) row[header[c] as string] = (cells[c] ?? "").trim();
    rows.push(row);
  }
  return rows;
}

function requireCols(rows: Row[], cols: string[], file: string): void {
  const header = new Set(Object.keys(rows[0] ?? {}));
  for (const col of cols) {
    if (!header.has(col)) throw new Error(`${file}: 缺列 ${col}`);
  }
}

function nonEmpty(value: string | undefined, file: string, what: string): string {
  if (value === undefined || value === "") throw new Error(`${file}: ${what} 为空`);
  return value;
}

function splitZh(raw: string, file: string, what: string): string[] {
  const parts = raw
    .split("|")
    .map((z) => z.trim())
    .filter((z) => z.length > 0);
  if (parts.length === 0) throw new Error(`${file}: ${what} 切分后为空`);
  return parts;
}

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

const REGEX_HINT = /[()[\]^$.*+?{}|\\]/;

function enTokens(en: string): string[] {
  return en.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter((t) => t.length > 0);
}

function versionOf(key: string): string | null {
  const modern = key.match(/(?:^|\/)projects\/assets\/[^/]+\/([\w.\-]+)\//);
  if (modern) return modern[1] as string;
  const legacy = key.match(/(?:^|\/)projects\/([\w.\-]+)\//);
  return legacy ? (legacy[1] as string) : null;
}

function applies(entry: IndexEntry, key: string, scopes: { domain: string; re: RegExp }[], version?: string): boolean {
  if (entry.domain !== undefined) {
    const scope = scopes.find((s) => s.domain === entry.domain);
    if (!scope || !scope.re.test(key)) return false;
  }
  if (entry.versions !== undefined) {
    const v = version ?? versionOf(key);
    if (v === null || !entry.versions.some((game) => mcMatches(v, game))) return false;
  }
  return true;
}

function zhContains(zhText: string, zh: string[], zhRegex?: boolean): boolean {
  if (zhRegex) {
    return zh.some((z) => {
      const re = safeRegex(z);
      return re !== undefined && z.length > 0 && re.test(zhText);
    });
  }
  const lower = zhText.toLowerCase();
  return zh.some((z) => z.length > 0 && lower.includes(z.toLowerCase()));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let pos = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) return n;
    n++;
    pos = idx + needle.length;
  }
}

function countEnMatches(en: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let n = 0;
  for (;;) {
    const m = global.exec(en);
    if (m === null) return n;
    n++;
    if (m[0].length === 0) global.lastIndex++;
  }
}

export function buildTermIndex(files: Record<string, string>): TermIndex {
  const phrases = new Map<string, IndexEntry[]>();
  const regex: IndexEntry[] = [];
  const scopes: { domain: string; re: RegExp }[] = [];
  const qa: CompiledQa[] = [];
  const all: TermRecord[] = [];
  let maxPhraseTokens = 1;

  const addPhrase = (en: string, entry: IndexEntry, record: TermRecord): void => {
    const tokens = enTokens(en);
    if (tokens.length === 0) return;
    const norm = tokens.join(" ");
    const existing = phrases.get(norm);
    if (existing) existing.push(entry);
    else phrases.set(norm, [entry]);
    if (tokens.length > maxPhraseTokens) maxPhraseTokens = tokens.length;
    all.push(record);
  };

  const main = files["terms-v1.tsv"];
  if (main !== undefined) {
    const rows = parseTsv(main, "terms-v1.tsv");
    requireCols(rows, ["en", "zh"], "terms-v1.tsv");
    rows.forEach((row, i) => {
      const en = nonEmpty(row.en, "terms-v1.tsv", `第${i + 2}行 en`);
      const zh = splitZh(nonEmpty(row.zh, "terms-v1.tsv", `第${i + 2}行 zh`), "terms-v1.tsv", `第${i + 2}行 zh`);
      const reason = row.reason;
      const record: TermRecord = { en, zh, ...(reason ? { reason } : {}) };
      addPhrase(en, { en, zh, ...(reason ? { reason } : {}) }, record);
    });
  }

  const specialKeys = Object.keys(files)
    .filter((key) => /^special\/terms-.+\.tsv$/.test(key))
    .sort();
  for (const key of specialKeys) {
    const token = key.slice("special/terms-".length, -".tsv".length);
    const rows = parseTsv(files[key] as string, key);
    requireCols(rows, ["en", "zh"], key);
    const scopeRe = safeRegex(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (scopeRe) scopes.push({ domain: token, re: scopeRe });
    rows.forEach((row, i) => {
      const en = nonEmpty(row.en, key, `第${i + 2}行 en`);
      const zh = splitZh(nonEmpty(row.zh, key, `第${i + 2}行 zh`), key, `第${i + 2}行 zh`);
      const reason = row.reason;
      const record: TermRecord = { en, zh, domain: token, ...(reason ? { reason } : {}) };
      addPhrase(en, { en, zh, domain: token, ...(reason ? { reason } : {}) }, record);
    });
  }

  const versioned = files["terms-version.tsv"];
  if (versioned !== undefined) {
    const rows = parseTsv(versioned, "terms-version.tsv");
    requireCols(rows, ["versions", "en", "zh"], "terms-version.tsv");
    rows.forEach((row, i) => {
      const versions = nonEmpty(row.versions, "terms-version.tsv", `第${i + 2}行 versions`)
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      const en = nonEmpty(row.en, "terms-version.tsv", `第${i + 2}行 en`);
      const zhRaw = nonEmpty(row.zh, "terms-version.tsv", `第${i + 2}行 zh`);
      const enRegex = REGEX_HINT.test(en);
      const zhRegex = REGEX_HINT.test(zhRaw);
      if (enRegex && !safeRegex(en)) throw new Error(`terms-version.tsv: 第${i + 2}行 en 非法正则: ${en}`);
      if (zhRegex && !safeRegex(zhRaw)) throw new Error(`terms-version.tsv: 第${i + 2}行 zh 非法正则: ${zhRaw}`);
      const zh = zhRegex
        ? [zhRaw]
        : zhRaw
            .split("|")
            .map((z) => z.trim())
            .filter((z) => z.length > 0);
      const reason = row.reason;
      const record: TermRecord = {
        en,
        zh,
        versions,
        ...(enRegex ? { enRegex: true } : {}),
        ...(zhRegex ? { zhRegex: true } : {}),
        ...(reason ? { reason } : {}),
      };
      all.push(record);
      if (enRegex) {
        const enRe = safeRegex(en);
        if (enRe) {
          regex.push({
            en,
            zh,
            enRe,
            versions,
            ...(reason ? { reason } : {}),
            ...(zhRegex ? { zhRegex: true } : {}),
          });
        }
      } else {
        addPhrase(
          en,
          { en, zh, versions, ...(reason ? { reason } : {}), ...(zhRegex ? { zhRegex: true } : {}) },
          record,
        );
      }
    });
  }

  const qaText = files["qa-rules.tsv"];
  if (qaText !== undefined) {
    const rows = parseTsv(qaText, "qa-rules.tsv");
    requireCols(rows, ["id", "en"], "qa-rules.tsv");
    rows.forEach((row, i) => {
      const id = nonEmpty(row.id, "qa-rules.tsv", `第${i + 2}行 id`);
      const en = nonEmpty(row.en, "qa-rules.tsv", `${id} en`);
      const enRe = safeRegex(en);
      if (!enRe) throw new Error(`qa-rules.tsv: ${id} en 非法正则: ${en}`);
      for (const [col, value] of [
        ["key", row.key],
        ["except_key", row.except_key],
        ["except_en", row.except_en],
      ] as const) {
        if (value && !safeRegex(value)) throw new Error(`qa-rules.tsv: ${id} ${col} 非法正则: ${value}`);
      }
      const keyRe = row.key ? safeRegex(row.key) : undefined;
      const exceptKeyRe = row.except_key ? safeRegex(row.except_key) : undefined;
      const exceptEnRe = row.except_en ? safeRegex(row.except_en) : undefined;
      qa.push({
        id,
        enRe,
        countMode: row.mode === "count",
        ...(keyRe ? { keyRe } : {}),
        ...(exceptKeyRe ? { exceptKeyRe } : {}),
        ...(row.require ? { require: row.require } : {}),
        ...(row.forbid ? { forbid: row.forbid } : {}),
        ...(exceptEnRe ? { exceptEnRe } : {}),
        ...(row.comment ? { comment: row.comment } : {}),
      });
    });
  }

  return { phrases, regex, scopes, qa, maxPhraseTokens, all };
}

export function matchTerms(
  index: TermIndex,
  key: string,
  en: string,
  zh: string,
  version?: string,
): TermHit[] {
  const hits: TermHit[] = [];
  const seen = new Set<string>();
  const push = (entry: IndexEntry, matchedEn: string): void => {
    const sig = `${entry.domain ?? ""}|${matchedEn}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    hits.push({
      en: entry.en,
      zh: entry.zh,
      ok: zhContains(zh, entry.zh, entry.zhRegex),
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.domain ? { domain: entry.domain } : {}),
    });
  };

  for (const entry of index.regex) {
    if (!applies(entry, key, index.scopes, version)) continue;
    if (entry.enRe && !entry.enRe.test(en)) continue;
    push(entry, entry.en);
  }

  const tokens = enTokens(en);
  if (tokens.length === 0 || index.phrases.size === 0) return hits;

  const consumed = new Array<boolean>(tokens.length).fill(false);
  const maxWindow = index.maxPhraseTokens;
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    for (let w = Math.min(maxWindow, tokens.length - i); w >= 1; w--) {
      if (consumed.slice(i, i + w).some(Boolean)) continue;
      const entries = index.phrases.get(tokens.slice(i, i + w).join(" "));
      if (!entries) continue;
      const applicable = entries.filter((entry) => applies(entry, key, index.scopes, version));
      if (applicable.length === 0) continue;
      const versionedHits = applicable.filter((entry) => entry.versions !== undefined);
      const specialHits = applicable.filter((entry) => entry.domain !== undefined);
      const chosen = versionedHits.length > 0 ? versionedHits : specialHits.length > 0 ? specialHits : applicable;
      for (const entry of chosen) push(entry, entry.en);
      for (let k = i; k < i + w; k++) consumed[k] = true;
      break;
    }
  }

  return hits;
}

export function matchQa(index: TermIndex, key: string, en: string, zh: string): QaHit[] {
  const hits: QaHit[] = [];
  for (const rule of index.qa) {
    if (rule.keyRe && !rule.keyRe.test(key)) continue;
    if (rule.exceptKeyRe && rule.exceptKeyRe.test(key)) continue;
    if (rule.exceptEnRe && rule.exceptEnRe.test(en)) continue;
    const matched = countEnMatches(en, rule.enRe);
    if (matched === 0) continue;
    let ok = true;
    if (rule.require !== undefined) {
      ok = rule.countMode ? countOccurrences(zh, rule.require) >= matched : zh.includes(rule.require);
    }
    if (ok && rule.forbid !== undefined && zh.includes(rule.forbid)) ok = false;
    hits.push({
      id: rule.id,
      ok,
      ...(rule.require !== undefined ? { require: rule.require } : {}),
      ...(rule.forbid !== undefined ? { forbid: rule.forbid } : {}),
      ...(rule.comment ? { comment: rule.comment } : {}),
    });
  }
  return hits;
}

export function lookupTerm(
  index: TermIndex,
  query: string,
  limit: number,
): { en: string; zh: string[]; reason?: string }[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (q === "" || limit <= 0) return [];
  const queryTokens = new Set(q.split(" ").filter((t) => t.length > 0));
  const scored = new Map<string, { score: number; record: TermRecord }>();
  for (const record of index.all) {
    const en = record.en.trim().toLowerCase().replace(/\s+/g, " ");
    let score = 0;
    if (en === q) score = 100;
    else if (en.startsWith(q)) score = 80;
    else if (en.includes(q)) score = 60;
    else if (record.zh.some((z) => z.toLowerCase().includes(q))) score = 50;
    else {
      const overlap = en.split(" ").filter((t) => queryTokens.has(t)).length;
      if (overlap > 0) score = 20 + overlap * 5;
    }
    if (score === 0) continue;
    const existing = scored.get(record.en);
    if (!existing || existing.score < score) scored.set(record.en, { score, record });
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || (a.record.en < b.record.en ? -1 : a.record.en > b.record.en ? 1 : 0))
    .slice(0, limit)
    .map(({ record }) => ({
      en: record.en,
      zh: record.zh,
      ...(record.reason ? { reason: record.reason } : {}),
    }));
}

async function collectTsvFiles(dir: string, base: string): Promise<{ path: string; mtimeMs: number; size: number }[]> {
  const found: { path: string; mtimeMs: number; size: number }[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return found;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      found.push(...(await collectTsvFiles(full, base)));
      continue;
    }
    if (!entry.endsWith(".tsv")) continue;
    found.push({ path: relative(base, full).split(sep).join("/"), mtimeMs: info.mtimeMs, size: info.size });
  }
  return found;
}

const termIndexCache = new Map<string, { key: string; index: TermIndex }>();

export async function loadTermIndex(dir: string): Promise<TermIndex> {
  const files = await collectTsvFiles(dir, dir);
  const cacheKey = files.map((f) => `${f.path}\u0000${f.mtimeMs}\u0000${f.size}`).join("\u0001");
  const cached = termIndexCache.get(dir);
  if (cached && cached.key === cacheKey) return cached.index;
  const contents: Record<string, string> = {};
  for (const file of files) {
    contents[file.path] = await readFile(join(dir, file.path), "utf8");
  }
  const index = buildTermIndex(contents);
  termIndexCache.set(dir, { key: cacheKey, index });
  return index;
}
