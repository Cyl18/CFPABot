// src/agent/tools/terms-extract.ts
// Custom tool: terms_extract — 从 ctx.aligned 的 changed 条目中构建 n-gram
// 术语候选（复用 flows/_shared/terminology 的 extractNgramTerms），后置
// stop word 过滤，并回扫收集出现位置 ref（key/en/zh/版本/路径）。
// 与 terms_ngram_build（全文件高频 = 模组术语库）互补：本工具聚焦 PR 改动的
// 条目，产出与本次改动对应的术语。不做语义判断 —— 哪些是术语由 agent 裁决，
// 用 dict_lookup op=set（source=internal）写入 ctx.dict。不自动落库。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, type Ctx } from "../session-ctx.js";
import type { LangReviewItem } from "../../flows/_shared/language/align-review-items.js";
import {
  extractNgramTerms,
  type NgramLangEntry,
} from "../../flows/_shared/terminology/index.js";

// ─── Param types ────────────────────────────────────────────────────────

export interface TermsExtractParams {
  /** n-gram 大小（1=单词，2=双词短语，3=三词短语），默认 2。 */
  n?: 1 | 2 | 3;
  /** 最小跨条目频次（出现在多少个不同条目中），默认 2。 */
  minFreq?: number;
  /** 每个 token 的最小字符数（过滤 "a"/"of" 等短词），默认 2。 */
  minLen?: number;
  /** 最多返回候选数，默认 50。 */
  maxTerms?: number;
  /** 只从涉及此 gameVersion 的条目提取术语（zh 取该版本），默认不传=全部版本。
   *  译前准备建议只提取单一版本（latest 或 latest 稳定版）——跨版本重复统计会稀释词频。 */
  version?: string;
}

function isTermsExtractParams(x: unknown): TermsExtractParams {
  if (typeof x !== "object" || x === null) return {};
  const p = x as Record<string, unknown>;
  const out: TermsExtractParams = {};
  if (p.n === 1 || p.n === 2 || p.n === 3) out.n = p.n;
  if (typeof p.minFreq === "number") out.minFreq = p.minFreq;
  if (typeof p.minLen === "number") out.minLen = p.minLen;
  if (typeof p.maxTerms === "number") out.maxTerms = p.maxTerms;
  if (typeof p.version === "string") out.version = p.version;
  return out;
}

// ─── Stop words（英文高频虚词，静态表）───────────────────────────────

const STOP_WORDS: Record<string, true> = {
  the: true, a: true, an: true, of: true, to: true, in: true, on: true, for: true,
  and: true, or: true, with: true, from: true, by: true, at: true, as: true,
  is: true, are: true, was: true, were: true, be: true, been: true, being: true,
  it: true, its: true, this: true, that: true, these: true, those: true,
  not: true, no: true, but: true, if: true, when: true, while: true,
  after: true, before: true, you: true, your: true, i: true, he: true, she: true,
  we: true, they: true, their: true, them: true, his: true, her: true, us: true,
  my: true, me: true, all: true, any: true, each: true, some: true, more: true,
  most: true, other: true, such: true, only: true, own: true, same: true,
  so: true, than: true, too: true, very: true, can: true, will: true,
  just: true, should: true, now: true, into: true, out: true, up: true, down: true,
  over: true, under: true, about: true, between: true, during: true, has: true,
  have: true, had: true, do: true, does: true, did: true, done: true, would: true,
  could: true, may: true, might: true, must: true, shall: true, what: true,
  which: true, who: true, whom: true, there: true, here: true, also: true,
  then: true, first: true, last: true, next: true, one: true, two: true, new: true,
};

/** 候选词及出现位置（供 agent 核对上下文）。 */
export interface TermCandidateRef {
  key: string;
  en?: string;
  zh?: string;
  gameVersion: string;
  path: string;
}

/** n-gram 筛选结果 —— 只给数据，术语与否由 agent 裁决。 */
export interface TermCandidate {
  word: string;
  /** 占比最高的 zh 翻译（extractNgramTerms 语义）。 */
  text: string;
  /** 跨条目频次。 */
  freq: number;
  /** 出现位置（≤5 个，防输出过大）。 */
  refs: TermCandidateRef[];
}

/** 条目英文原文（历史条目不参与统计）。 */
function itemEnglish(it: LangReviewItem): string | undefined {
  if (it.scope !== "changed") return undefined;
  return it.headEn ?? it.baseEn;
}

/** 英文 tokenize：非字母数字分割、小写（与 ngram.ts TOKEN_RE 对齐的近似）。 */
function tokenize(en: string): string[] {
  return en.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** tokens 是否包含连续子序列 phrase。 */
function containsSequence(tokens: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** 噪声短语 → 丢弃：全部 token 都是 stop word/纯数字，或首 token 是 stop word
 *  （"of interest" 不以实词开头，不是术语；"point of interest" 保留）。 */
function isNoisePhrase(word: string): boolean {
  const tokens = word.toLowerCase().split(" ");
  if (tokens.every((t) => STOP_WORDS[t] || /^[0-9]+$/.test(t))) return true;
  return STOP_WORDS[tokens[0]!] === true;
}

/**
 * 从对齐条目构建 n-gram 术语候选（纯函数）：
 * ctx.aligned items → NgramLangEntry[] → extractNgramTerms → stop word 后置过滤 → refs 回扫。
 * version 传定时只统计涉及该版本的条目，zh 取该版本（单一版本提取，词频不跨版本稀释）。
 */
export function extractTermCandidates(
  items: LangReviewItem[],
  opts: { n?: 1 | 2 | 3; minFreq?: number; minLen?: number; maxTerms?: number; version?: string } = {},
): TermCandidate[] {
  const targetVersion = opts.version;
  const itemVersionsOf = (it: LangReviewItem): { gameVersion: string; path: string; headZh?: string; baseZh?: string }[] =>
    it.versions && it.versions.length > 0
      ? it.versions
      : [{ gameVersion: it.mod.gameVersion, path: it.path, headZh: it.headZh, baseZh: it.baseZh }];
  /** 条目在目标版本下的 zh（不传 version 时取首版本）。 */
  const zhForVersion = (it: LangReviewItem): string | undefined => {
    const vers = itemVersionsOf(it);
    const v = targetVersion ? vers.find((x) => x.gameVersion.includes(targetVersion)) : vers[0];
    if (targetVersion && !v) return undefined;
    return v?.headZh ?? v?.baseZh;
  };

  const entries: NgramLangEntry[] = [];
  for (const it of items) {
    const en = itemEnglish(it);
    if (en === undefined) continue;
    const zh = zhForVersion(it);
    if (zh === undefined) continue;
    const vers = itemVersionsOf(it);
    const v = targetVersion ? vers.find((x) => x.gameVersion.includes(targetVersion)) : vers[0];
    entries.push({
      en,
      zh,
      path: v?.path ?? it.path,
      version: v?.gameVersion ?? it.mod.gameVersion,
      domain: it.mod.domain,
    });
  }
  const candidates = extractNgramTerms(entries, {
    n: opts.n ?? 2,
    minFreq: opts.minFreq,
    minLen: opts.minLen,
    maxTerms: opts.maxTerms ?? 50,
  });

  // refs 回扫：候选 word 在哪些条目中出现（≤5 处）。
  const result: TermCandidate[] = [];
  for (const c of candidates) {
    if (isNoisePhrase(c.word)) continue;
    const phrase = c.word.toLowerCase().split(" ");
    const refs: TermCandidateRef[] = [];
    for (const it of items) {
      const en = itemEnglish(it);
      if (en === undefined) continue;
      if (!containsSequence(tokenize(en), phrase)) continue;
      refs.push({
        key: it.key,
        gameVersion: it.versions?.[0]?.gameVersion ?? it.mod.gameVersion,
        path: it.versions?.[0]?.path ?? it.path,
        ...(en !== undefined ? { en } : {}),
        ...(zhForVersion(it) !== undefined ? { zh: zhForVersion(it) } : {}),
      });
      if (refs.length >= 5) break;
    }
    result.push({ word: c.word, text: c.text, freq: c.freq, refs });
  }
  return result;
}

// ─── Tool ────────────────────────────────────────────────────────────────

export function createTermsExtractTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    n: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], { description: "n-gram 大小（1=单词，2=双词短语，3=三词短语），默认 2" })),
    minFreq: Type.Optional(Type.Number({ description: "最小跨条目频次（出现在多少个不同条目中），默认 2" })),
    minLen: Type.Optional(Type.Number({ description: "每个 token 的最小字符数（过滤 a/of 等短词），默认 2" })),
    maxTerms: Type.Optional(Type.Number({ description: "最多返回候选数，默认 50" })),
    version: Type.Optional(Type.String({ description: "只从涉及此 gameVersion 的条目提取（zh 取该版本），默认全部版本。译前准备建议单一版本（latest 或 latest 稳定版）" })),
  });

  return {
    name: "terms_extract",
    label: "对齐条目 n-gram 术语候选",
    description:
      "从 ctx.aligned 的 changed 条目中构建 n-gram 术语候选（n=1/2/3，默认双词短语）：跨条目高频 + stop word 过滤，输出候选（word/text/freq）及出现位置 ref（key/en/zh/版本/路径，每词 ≤5 处）。**译前准备建议只从单一版本提取（传 version，latest 或 latest 稳定版）——跨版本重复统计会稀释词频**。与 terms_ngram_build（全文件高频 = 模组术语库）互补——本工具聚焦本次 PR 改动的条目。不做语义判断：哪些是术语由你裁决，用 dict_lookup op=set 写入 ctx.dict（source=internal）。不自动落库。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isTermsExtractParams(params);
      const ctx: Ctx = getSessionCtx(sessionId);

      const aligned = (ctx.aligned as unknown as { items: LangReviewItem[]; candidates: unknown[] }[]) ?? [];
      const items = aligned.flatMap((r) => r.items ?? []);
      if (items.length === 0) {
        const err = { ok: false, error: "ctx.aligned 为空，请先调用 review_align" };
        return {
          content: [{ type: "text", text: JSON.stringify(err) }],
          details: err,
        };
      }

      const candidates = extractTermCandidates(items, p);

      const summary = {
        ok: true,
        candidates,
        totalItems: items.length,
        note: "候选只是筛选：请逐条裁决哪些是术语，用 dict_lookup op=set 写入 ctx.dict（source=internal）。",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: summary,
      };
    },
  };
}
