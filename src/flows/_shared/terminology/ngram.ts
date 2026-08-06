// src/flows/_shared/terminology/ngram.ts
// PURE: n-gram term candidate extraction from language entries.
// No I/O, no globals, no side effects.

/** 一条语料: en 文本 + 对应 zh 翻译,附带来源路径与版本/域信息。 */
export interface NgramLangEntry {
  /** 英文原文(用于 n-gram 切词) */
  en: string;
  /** 对应中文翻译(用于候选术语的 text) */
  zh: string;
  /** 来源文件路径(zh_cn 语言文件) */
  path: string;
  /** 游戏版本段(如 "1.20.1") */
  version: string;
  /** 模组命名空间/domain 段 */
  domain: string;
}

/** n-gram 提取参数(均可选,有默认值)。 */
export interface NgramOptions {
  /** n-gram 大小,默认 2(bigram) */
  n?: 1 | 2 | 3;
  /** 最小跨条目频次(出现在多少个不同条目中),默认 2 */
  minFreq?: number;
  /** 每个 token 的最小字符数(过滤 "a"/"of" 等短词),默认 2 */
  minLen?: number;
  /** 最多返回候选数,默认 200 */
  maxTerms?: number;
}

/** 一个 n-gram 术语候选。 */
export interface NgramTermCandidate {
  /** n-gram 词(保留出现最多的原始大小写形式, token 间以空格连接) */
  word: string;
  /** 出现该 n-gram 的条目中占比最高的 zh 翻译 */
  text: string;
  /** 出现该 n-gram 的不同条目数(跨条目频次) */
  freq: number;
  /** 备注(频次标注) */
  note: string;
}

interface NgramAgg {
  /** 原始大小写形式 -> 出现次数(用于挑选 word) */
  forms: Map<string, number>;
  /** 包含该 n-gram 的条目下标(跨条目去重) */
  entryIds: Set<number>;
  /** zh 翻译 -> 包含条目数(用于挑选占比最高的 text) */
  zhCounts: Map<string, number>;
}

/** 按空白/标点切词: 仅保留字母/数字连续串(Unicode 感知)。 */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * 从语料条目中提取跨条目重复出现的 n-gram 术语候选。
 *
 * 规则:
 * - EN 侧按空白/标点切词,取连续 n 个 token 构成 n-gram;
 * - 大小写归一统计(如 "Iron Ingot" 与 "iron ingot" 视为同一术语),
 *   word 取出现最多的原始大小写形式;
 * - 只统计"跨条目"频次: 同一 n-gram 在一个条目内重复出现只计 1;
 * - text 取出现该 n-gram 的条目中占比最高的 zh 翻译(并列取字典序最小);
 * - 结果按 freq 降序、word 升序排列,截断到 maxTerms。
 *
 * @param entries 语料条目(每条含 en/zh/path/version/domain)
 * @param options 提取参数(见 NgramOptions)
 * @returns 按频次降序排列的候选术语数组
 */
export function extractNgramTerms(
  entries: NgramLangEntry[],
  options?: NgramOptions,
): NgramTermCandidate[] {
  const requestedN = options?.n;
  const nn: 1 | 2 | 3 = requestedN === 1 || requestedN === 3 ? requestedN : 2;
  const minFreq = Math.max(1, Math.floor(options?.minFreq ?? 2));
  const minLen = Math.max(1, Math.floor(options?.minLen ?? 2));
  const maxTerms = Math.max(1, Math.floor(options?.maxTerms ?? 200));

  if (entries.length === 0) return [];

  const agg = new Map<string, NgramAgg>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.en) continue;

    // 切词并按 minLen 过滤短 token
    const tokens: string[] = [];
    for (const match of entry.en.matchAll(TOKEN_RE)) {
      const tok = match[0];
      if (tok.length >= minLen) tokens.push(tok);
    }
    if (tokens.length < nn) continue;

    // 该条目内已计入的 n-gram(去重: 同条目重复出现只算一次频次)
    const seenInEntry = new Set<string>();
    for (let t = 0; t + nn <= tokens.length; t++) {
      const word = tokens.slice(t, t + nn).join(" ");
      const key = word.toLowerCase();

      let a = agg.get(key);
      if (!a) {
        a = { forms: new Map(), entryIds: new Set(), zhCounts: new Map() };
        agg.set(key, a);
      }
      // 大小写形式按出现次数统计(跨条目频次才去重)
      a.forms.set(word, (a.forms.get(word) ?? 0) + 1);

      if (seenInEntry.has(key)) continue;
      seenInEntry.add(key);
      a.entryIds.add(i);
      a.zhCounts.set(entry.zh, (a.zhCounts.get(entry.zh) ?? 0) + 1);
    }
  }

  const results: NgramTermCandidate[] = [];
  for (const [key, a] of agg) {
    const freq = a.entryIds.size;
    if (freq < minFreq) continue;

    // 出现最多的原始大小写形式(并列取字典序最小,保证确定性)
    let word = "";
    let wordCount = -1;
    for (const [form, count] of a.forms) {
      if (count > wordCount || (count === wordCount && (word === "" || form < word))) {
        word = form;
        wordCount = count;
      }
    }

    // 占比最高的 zh 翻译(并列取字典序最小)
    let text = "";
    let textCount = -1;
    for (const [zh, count] of a.zhCounts) {
      if (count > textCount || (count === textCount && (text === "" || zh < text))) {
        text = zh;
        textCount = count;
      }
    }

    results.push({
      word,
      text,
      freq,
      note: `出现于 ${freq} 个条目(${nn}-gram)`,
    });
  }

  // freq 降序, word 升序(确定性输出)
  results.sort(
    (x, y) => y.freq - x.freq || (x.word < y.word ? -1 : x.word > y.word ? 1 : 0),
  );

  return results.slice(0, maxTerms);
}
