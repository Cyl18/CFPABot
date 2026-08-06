// src/flows/_shared/terminology/term-match.ts
// PURE: 行级术语匹配（译前准备用）。一次构建匹配器（hash 短语表 + regex 列表），
// 逐行匹配。无 I/O，无状态。
//
//   来源分层（用户 2026-08-04 定稿）：
//   - internal/external/agent_search/ngram: agent 建立的术语库（ctx.dict）
//   - vanilla: 原版术语，绕过 agent 自动注入（config/vanilla-terms.json）
//     - 非 regex（无 key/en scope 或仅 version scope）→ hash 短语匹配
//     - regex（key/en scope 为正则）→ 逐条正则匹配（O(n·m)）
//   每行术语命中带 ok 标记：行 zh 包含术语 zh → 遵守；不包含 → 术语匹配失败（提示模型）。

/** 与 agent/session-ctx.ts 的 DictSource 同构（_shared 不得依赖 agent 层，结构对齐）。 */
export type TermSource = "agent_search" | "forced_vanilla" | "internal" | "ngram" | "tm" | "vanilla";

export interface VanillaTerm {
  /** 英文原文（multi-en） */
  en: string[];
  /** 中文译文（multi-zh，任一命中即视为遵守） */
  zh: string[];
  /** 可选约束：key/en 为正则，version 为最低版本（'1.12.2' 表示仅 ≥1.12.2） */
  scope?: { key?: string; en?: string; version?: string };
}

export interface DictTerm {
  word: string;
  text: string;
  source: Exclude<TermSource, "vanilla">;
}

export interface TermMatchHit {
  source: TermSource;
  en: string;
  zh: string[];
  /** 行 zh 是否包含术语 zh（任一）—— false = 术语匹配失败 */
  ok: boolean;
}

interface HashEntry {
  en: string;
  zh: string[];
  source: TermSource;
}

interface RegexEntry {
  source: TermSource;
  en: string;
  zh: string[];
  keyRe?: RegExp;
  enRe?: RegExp;
  version?: string;
}

export interface TermMatcher {
  /** 短语表：规范化短语（小写、空白折叠）→ 条目（同短语多译法合并） */
  phrases: Map<string, HashEntry[]>;
  /** 正则/版本约束条目：逐条匹配 */
  regex: RegexEntry[];
  /** 最长短语 token 数（滑动窗口上限） */
  maxPhraseTokens: number;
}

const VERSION_SCOPE_RE = /^\d[\w.\-]*$/;

/** 规范化短语：小写 + 折叠空白。 */
function normalizePhrase(p: string): string {
  return p.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 简单版本比较：'1.21.1' >= '1.20' 等。数字段逐段比较，段内按数字。 */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string): (number | string)[] =>
    v.split(/[.\-_]/).map((seg) => (seg === "" ? 0 : /^\d+$/.test(seg) ? Number(seg) : seg));
  const a = parse(version);
  const b = parse(min);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x > y;
    } else if (String(x) !== String(y)) {
      return String(x) > String(y);
    }
  }
  return true;
}

/**
 * 构建匹配器。dictTerms 来自 ctx.dict（agent 建立的库），vanilla 来自
 * config/vanilla-terms.json（自动注入）。vanilla 条目多 en/多 zh；regex 判定：
 * scope.key/scope.en 存在且非纯版本 → 逐条；否则进 hash 短语表。
 */
export function buildTermMatcher(dictTerms: DictTerm[], vanilla: VanillaTerm[]): TermMatcher {
  const phrases = new Map<string, HashEntry[]>();
  const regex: RegexEntry[] = [];
  let maxPhraseTokens = 1;

  const addPhrase = (en: string, zh: string[], source: TermSource): void => {
    const norm = normalizePhrase(en);
    if (norm.length === 0) return;
    const hit = phrases.get(norm);
    if (hit) {
      hit.push({ en, zh, source });
    } else {
      phrases.set(norm, [{ en, zh, source }]);
    }
    const tokens = norm.split(" ").length;
    if (tokens > maxPhraseTokens) maxPhraseTokens = tokens;
  };

  for (const t of dictTerms) {
    if (!t.word || !t.text) continue;
    addPhrase(t.word, [t.text], t.source);
  }

  for (const t of vanilla) {
    const hasRegex = (s: string | undefined): boolean =>
      s !== undefined && !VERSION_SCOPE_RE.test(s);
    const keyRe = hasRegex(t.scope?.key) ? safeRegex(t.scope!.key!) : undefined;
    const enRe = hasRegex(t.scope?.en) ? safeRegex(t.scope!.en!) : undefined;
    const version = t.scope?.version && VERSION_SCOPE_RE.test(t.scope.version) ? t.scope.version : undefined;
    if (keyRe || enRe || version) {
      for (const en of t.en) {
        regex.push({ source: "vanilla", en, zh: t.zh, keyRe, enRe, version });
      }
    } else {
      for (const en of t.en) {
        addPhrase(en, t.zh, "vanilla");
      }
    }
  }

  return { phrases, regex, maxPhraseTokens };
}

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/** 行 zh 是否包含术语任一 zh（子串包含，忽略大小写）。 */
function zhContains(zhText: string, zh: string[]): boolean {
  const lower = zhText.toLowerCase();
  return zh.some((z) => z.length > 0 && lower.includes(z.toLowerCase()));
}

/**
 * 匹配一行：返回该行命中的术语（含 ok 标记）。匹配对象 = 行 en 的 token
 * 滑动窗口查短语表（hash，O(n·w)）+ regex 逐条（O(m)）。窗口为 1..maxPhraseTokens
 * 的连续 token 序列；窗口 token 数与短语 token 数一致时才查表（精确短语）。
 */
export function matchRowTerms(
  matcher: TermMatcher,
  key: string,
  en: string,
  zh: string,
): TermMatchHit[] {
  const hits: TermMatchHit[] = [];
  const seen = new Set<string>();

  const pushHit = (entry: HashEntry | RegexEntry, matchedEn: string): void => {
    const sig = `${entry.source}|${matchedEn}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    hits.push({
      source: entry.source,
      en: entry.en,
      zh: entry.zh,
      ok: zhContains(zh, entry.zh),
    });
  };

  // 1. regex 逐条（key/en 正则 + 版本门槛）
  for (const entry of matcher.regex) {
    if (entry.keyRe && !entry.keyRe.test(key)) continue;
    if (entry.enRe && !entry.enRe.test(en)) continue;
    if (entry.version && !versionAtLeast(versionOf(key) ?? "", entry.version)) continue;
    if (enContains(en, entry.en)) pushHit(entry, entry.en);
  }

  // 2. hash 短语滑动窗口
  if (matcher.phrases.size > 0) {
    const tokens = en.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter((t) => t.length > 0);
    const maxW = Math.min(matcher.maxPhraseTokens, tokens.length);
    for (let w = 1; w <= maxW; w++) {
      for (let i = 0; i + w <= tokens.length; i++) {
        const phrase = tokens.slice(i, i + w).join(" ");
        const entries = matcher.phrases.get(phrase);
        if (!entries) continue;
        for (const entry of entries) pushHit(entry, entry.en);
      }
    }
  }

  return hits;
}

/** 行 en 是否包含短语（词边界子串匹配：整词序列出现）。 */
function enContains(en: string, phrase: string): boolean {
  const tokens = en.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter((t) => t.length > 0);
  const phraseTokens = phrase.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter((t) => t.length > 0);
  if (phraseTokens.length === 0) return false;
  if (phraseTokens.length === 1) return tokens.includes(phraseTokens[0]!);
  for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** 从 key 提取版本（projects/1.20.1/... 布局）。 */
function versionOf(key: string): string | null {
  const m = key.match(/(?:^|\/)projects\/([\w.\-]+)\//);
  return m?.[1] ?? null;
}
