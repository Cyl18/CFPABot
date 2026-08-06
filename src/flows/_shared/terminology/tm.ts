// src/flows/_shared/terminology/tm.ts
// PURE: 翻译记忆(TM)索引构建与检索 — BM25 相关性排序 + Levenshtein 编辑距离模糊匹配。
// 无 I/O、无全局状态、无副作用。
//
// 索引结构刻意设计为可直接 JSON 序列化(Record 而非 Map), 由 tm_build Flow 落盘到
// runtime/cache/tm/{slug}.json, tm_query 工具读回后直接复用同一组纯函数。
//
// 审查语义: TM 召回必须返回**多候选**——同一英文词条的不同译法(zH)正是审查重点,
// 因此去重仅发生在「同 en 且同 zh」时(合并计数), 不同 zh 的文档全部保留。

// ─── 常量 ─────────────────────────────────────────────────────────────

/** BM25 k1(词频饱和参数) */
export const TM_K1 = 1.5;
/** BM25 b(文档长度归一化参数) */
export const TM_B = 0.75;

// ─── 类型 ─────────────────────────────────────────────────────────────

/** 一条原始语料: 英文原文 + 中文译文 + 来源文件路径。 */
export interface TmEntry {
  en: string;
  zh: string;
  path: string;
}

/** 去重合并后的索引文档(数组下标即 docId)。 */
export interface TmDoc {
  /** 分词后的小写词元序列(含重复, 用于计算词频与文档长度) */
  terms: string[];
  en: string;
  zh: string;
  /** 语料来源文件路径(取该 (en,zh) 首次出现的 en_us 文件) */
  path: string;
  /** 同 (en,zh) 语料合并后的出现次数 */
  freq: number;
}

/** 可 JSON 序列化的 BM25 倒排索引。 */
export interface TmIndex {
  /** 文档数组, 下标即 docId */
  docs: TmDoc[];
  /** term → 文档频率(包含该 term 的文档数) */
  df: Record<string, number>;
  /** term → docId 列表(倒排表, 每个 docId 至多出现一次) */
  postings: Record<string, number[]>;
  /** 平均文档长度(词元数) */
  avgDocLen: number;
  totalDocs: number;
  k1: number;
  b: number;
}

/** 检索命中。score 语义: 越大越相关(BM25 得分 / 模糊距离的倒数)。 */
export interface TmHit {
  en: string;
  zh: string;
  path: string;
  score: number;
  freq: number;
}

/** 落盘文件结构: 元信息 + 索引本体。 */
export interface TmIndexFile {
  slug: string;
  ref: "base" | "head";
  /** 实际读取语料的提交 SHA */
  sha: string;
  builtAt: string;
  index: TmIndex;
}

// ─── 分词 ─────────────────────────────────────────────────────────────

/** 按空白/标点/符号切分并小写。空词元被丢弃。 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length > 0);
}

// ─── 索引构建 ──────────────────────────────────────────────────────────

/**
 * 从原始语料构建 TM 索引。
 * 去重规则: 同 en 且同 zh 合并为一条(计数累加到 freq, 保留首个 path);
 * 同 en 不同 zh 的条目全部保留——多译法候选是审查重点。
 */
export function buildTmIndex(entries: TmEntry[]): TmIndex {
  // 1. 去重合并
  const seen = new Map<string, TmDoc>();
  for (const e of entries) {
    const key = `${e.en}\u0000${e.zh}`;
    const existing = seen.get(key);
    if (existing) {
      existing.freq += 1;
    } else {
      seen.set(key, {
        terms: tokenize(e.en),
        en: e.en,
        zh: e.zh,
        path: e.path,
        freq: 1,
      });
    }
  }
  const docs = [...seen.values()];

  // 2. 倒排表 + 文档频率(按 docId 升序写入, 便于并集去重)
  const postings: Record<string, number[]> = {};
  const df: Record<string, number> = {};
  docs.forEach((doc, docId) => {
    const unique = new Set(doc.terms);
    for (const t of unique) {
      let list = postings[t];
      if (!list) {
        list = [];
        postings[t] = list;
      }
      list.push(docId);
      df[t] = (df[t] ?? 0) + 1;
    }
  });

  // 3. 平均文档长度
  const totalTerms = docs.reduce((n, d) => n + d.terms.length, 0);
  const avgDocLen = docs.length > 0 ? totalTerms / docs.length : 0;

  return {
    docs,
    df,
    postings,
    avgDocLen,
    totalDocs: docs.length,
    k1: TM_K1,
    b: TM_B,
  };
}

// ─── BM25 检索 ────────────────────────────────────────────────────────

export interface SearchTmOptions {
  /** 返回条数上限, 默认 5; ≤0 表示不限制 */
  topK?: number;
}

/** 统计词元 t 在文档中的出现次数。 */
function countToken(terms: string[], t: string): number {
  let n = 0;
  for (const w of terms) if (w === t) n += 1;
  return n;
}

/**
 * BM25 相关性检索。查询被分词后逐 term 取倒排表累加得分。
 * 空查询、空索引返回 []。多候选语义: 同一 en 的不同 zh 是独立文档, 全部参与排序。
 */
export function searchTm(index: TmIndex, query: string, opts: SearchTmOptions = {}): TmHit[] {
  const topK = opts.topK ?? 5;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || index.totalDocs === 0 || index.avgDocLen <= 0) {
    return [];
  }

  const { k1, b, avgDocLen, totalDocs, postings, df, docs } = index;
  const scores = new Map<number, number>();

  for (const t of queryTerms) {
    const docIds = postings[t];
    if (!docIds || docIds.length === 0) continue;
    const docFreq = df[t] ?? docIds.length;
    const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
    for (const docId of docIds) {
      const doc = docs[docId];
      if (!doc) continue;
      const tf = countToken(doc.terms, t);
      const denom = tf + k1 * (1 - b + b * (doc.terms.length / avgDocLen));
      const inc = (idf * (tf * (k1 + 1))) / denom;
      scores.set(docId, (scores.get(docId) ?? 0) + inc);
    }
  }

  const hits: TmHit[] = [...scores.entries()]
    .map(([docId, score]) => {
      const doc = docs[docId]!;
      return { en: doc.en, zh: doc.zh, path: doc.path, score, freq: doc.freq };
    })
    .sort((a, b) => b.score - a.score);

  return topK > 0 ? hits.slice(0, topK) : hits;
}

// ─── 模糊检索(编辑距离) ───────────────────────────────────────────────

export interface FuzzyFindOptions {
  /** 允许的最大编辑距离, 默认 2 */
  maxDist?: number;
  /** 返回条数上限, 默认不限制; ≤0 表示不限制 */
  topK?: number;
}

/** 手写 Levenshtein 编辑距离(滚动数组 DP, O(m·n) 时间 O(n) 空间)。 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * en 与 query 的模糊匹配距离: 取「整串 vs 整串」与「逐词 vs 逐词(query 词元 ↔ en 词元)」
 * 中的最小值。长度差超过 maxDist 的串不可能达标, 直接剪枝。
 * 无 ≤ maxDist 的匹配返回 null。
 */
function fuzzyDistance(en: string, query: string, maxDist: number): number | null {
  const queryWords = tokenize(query);
  let best = Infinity;
  const consider = (s: string, q: string): void => {
    if (Math.abs(s.length - q.length) > maxDist) return;
    const d = levenshtein(s, q);
    if (d < best) best = d;
  };
  // 整串 vs 整串
  consider(en.toLowerCase(), query);
  // 逐词 vs 逐词
  for (const w of tokenize(en)) {
    for (const qw of queryWords) consider(w, qw);
  }
  return best <= maxDist ? best : null;
}

/**
 * 编辑距离模糊匹配: 命中 en 整串或其任意词元与 query 距离 ≤ maxDist 的文档。
 * 按距离升序(同距离按 freq 降序)。score = 1 / (1 + dist), 越大越接近。
 */
export function fuzzyFind(index: TmIndex, query: string, opts: FuzzyFindOptions = {}): TmHit[] {
  const maxDist = opts.maxDist ?? 2;
  const q = query.trim().toLowerCase();
  if (q.length === 0 || index.totalDocs === 0) return [];

  interface Candidate {
    doc: TmDoc;
    dist: number;
  }
  const candidates: Candidate[] = [];
  for (const doc of index.docs) {
    const dist = fuzzyDistance(doc.en, q, maxDist);
    if (dist !== null) candidates.push({ doc, dist });
  }

  candidates.sort((a, b) => a.dist - b.dist || b.doc.freq - a.doc.freq);

  const hits: TmHit[] = candidates.map((c) => ({
    en: c.doc.en,
    zh: c.doc.zh,
    path: c.doc.path,
    score: 1 / (1 + c.dist),
    freq: c.doc.freq,
  }));

  return opts.topK && opts.topK > 0 ? hits.slice(0, opts.topK) : hits;
}
