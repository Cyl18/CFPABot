// src/agent/tools/review-prep.ts
// Custom tool: review_prep — 译前准备（自动批量，不调用 LLM）。
// 对 ctx.aligned 每个条目:
//   1. TM 批量查询: 按行 mod.slug 读 tm 索引(每 slug 一次加载), BM25 + 模糊, 各前 2 条
//   2. 术语匹配: ctx.dict(agent 建立的 internal/external/agent_search/ngram)
//      + config/vanilla-terms.json(原版, 绕过 agent 自动注入; regex scope 逐条,
//      其余 hash 短语匹配) → matchRowTerms
//   3. 结果写入条目 prep 字段(软意见, 无 verdict/reason), MoA prompt 渲染参考
//
// 设计契约 (2026-08-04): 术语匹配失败(行 en 含术语但 zh 不含)在 prompt 中提示
// 模型判断(误报通道 program_false_positive); TM 命中仅作参考不判对错。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx, type DictEntry } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";
import { readJsonFile } from "../../_shared/fs-utils.js";
import { tmIndexPath } from "../../runtime-paths.js";
import { queryTm, type TmIndexFile } from "../../flows/_shared/terminology/index.js";
import {
  buildTermMatcher,
  matchRowTerms,
  type TermMatchHit,
  type VanillaTerm,
} from "../../flows/_shared/terminology/term-match.js";
import type { LangReviewItem, PrepRow } from "../../flows/_shared/language/align-review-items.js";

const TM_TOP_K = 2;

let vanillaCache: VanillaTerm[] | null = null;
async function loadVanillaTerms(): Promise<VanillaTerm[]> {
  if (vanillaCache) return vanillaCache;
  const file = await readJsonFile<{ terms?: VanillaTerm[] }>("config/vanilla-terms.json");
  vanillaCache = file?.terms ?? [];
  return vanillaCache;
}

/** 行 en（head 优先）与全部候选 zh（合并条目各版本）。 */
function rowTexts(it: LangReviewItem): { en?: string; zhs: string[] } {
  const en = it.headEn ?? it.baseEn;
  const zhs: string[] = [];
  if (it.versions) {
    for (const v of it.versions) {
      const zh = v.headZh ?? v.baseZh;
      if (zh !== undefined) zhs.push(zh);
    }
  }
  const single = it.headZh ?? it.baseZh;
  if (single !== undefined && !zhs.includes(single)) zhs.push(single);
  return { en, zhs };
}

export function createReviewPrepTool(sessionId: string): ToolDefinition {
  return {
    name: "review_prep",
    label: "译前准备（自动批量）",
    description:
      "对 ctx.aligned 每个条目自动做译前准备（不调用 LLM）：①TM 翻译记忆批量查询（按模组索引一次加载，BM25+模糊各前 2 条，写入 prep.tm 参考）；②术语匹配（agent 建立的术语库 + 原版 vanilla 自动注入，绕过 agent；原版含正则 scope 的逐条匹配，其余 hash 短语匹配，写入 prep.terms，未遵守标记 ok=false）。软意见，无 verdict/reason；MoA 审查时可见。术语清洗（terms_distill）前调用不影响本工具（术语库来自 ctx.dict）。",
    parameters: Type.Object({}),
    execute: async () => {
      const ctx = getSessionCtx(sessionId);
      const aligned = (ctx.aligned as unknown as { items: LangReviewItem[] }[]) ?? [];
      if (aligned.length === 0 || aligned.every((r) => (r.items ?? []).length === 0)) {
        const err = { ok: false, error: "ctx.aligned 为空，请先调用 review_align" };
        return {
          content: [{ type: "text", text: JSON.stringify(err) }],
          details: err,
        };
      }

      // ── 术语匹配器（一次构建） ──────────────────────────────
      const dictTerms = (ctx.dict ?? []).map((d: DictEntry) => ({
        word: d.word,
        text: d.text,
        source: d.source,
      }));
      const vanilla = await loadVanillaTerms();
      const matcher = buildTermMatcher(dictTerms, vanilla);

      // ── TM 索引缓存（每 slug 一次读盘） ─────────────────────
      const tmCache = new Map<string, TmIndexFile | null>();

      let tmHits = 0;
      let termHits = 0;
      let termMisses = 0;

      for (const res of aligned) {
        for (const it of res.items ?? []) {
          const { en, zhs } = rowTexts(it);
          const prep: PrepRow = {};

          // TM 批量
          const slug = it.mod.slug;
          if (slug && en !== undefined) {
            let idx = tmCache.get(slug);
            if (idx === undefined) {
              const file = await readJsonFile<TmIndexFile>(tmIndexPath(slug));
              idx = file ?? null;
              tmCache.set(slug, idx);
            }
            if (idx?.index) {
              // 统一入口: 先精确命中, 缺失才模糊; 已按置信惩罚+短串阈值处理
              const res = queryTm(idx.index, en, { topK: TM_TOP_K, maxDist: 2 });
              const merged: PrepRow["tm"] = [];
              for (const h of res.all) {
                merged.push({ en: h.en, zh: h.zh, path: h.path, score: h.score });
              }
              if (merged.length > 0) {
                prep.tm = merged;
                tmHits += merged.length;
              }
            }
          }

          // 术语匹配（ok 判定：任一版本 zh 遵守）
          if (en !== undefined) {
            const zhAll = zhs.join("\n");
            const hits: TermMatchHit[] = matchRowTerms(matcher, it.key, en, zhAll);
            if (hits.length > 0) {
              prep.terms = hits.map((h) => ({
                source: h.source,
                en: h.en,
                zh: h.zh,
                ok: h.ok,
              }));
              termHits += hits.filter((h) => h.ok).length;
              termMisses += hits.filter((h) => !h.ok).length;
            }
          }

          it.prep = prep;
        }
      }

      setSessionCtx(sessionId, { ...ctx, aligned: ctx.aligned });
      await persistSessionCtx(sessionId);

      const result = {
        ok: true,
        rows: aligned.reduce((s, r) => s + (r.items?.length ?? 0), 0),
        tmHits,
        termHits,
        termMisses,
        vanillaTerms: vanilla.length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
