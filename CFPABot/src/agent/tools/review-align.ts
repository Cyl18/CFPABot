// src/agent/tools/review-align.ts
// Custom tool: review_align — align EN/ZH lang-entry maps by key for one or
// more mod paths, detect program candidates (missing/orphan/stale/untranslated
// format/placeholder mismatch), and write the result to ctx.aligned.

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx, type Ctx } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";
import { parseLangFile } from "../../flows/_shared/language/index.js";
import { alignLangReviewItems, mergeAlignedItems } from "../../flows/_shared/language/align-review-items.js";
import type { AlignReviewItemsInput, AlignReviewItemsResult } from "../../flows/_shared/language/align-review-items.js";

export interface ReviewAlignMod {
  slug: string;
  gameVersion: string;
  domain: string;
}

export interface ReviewAlignPair {
  mod: ReviewAlignMod;
  path: string;
  baseEnContent?: string;
  headEnContent?: string;
  baseZhContent?: string;
  headZhContent?: string;
  format?: "json" | "lang";
}

export interface ReviewAlignParams {
  pairs: ReviewAlignPair[];
  scope: {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    headSha: string;
  };
}

function isReviewAlignParams(x: unknown): x is ReviewAlignParams {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (!Array.isArray(p.pairs) || p.pairs.length === 0) return false;
  const s = p.scope as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return false;
  return (
    typeof s.repoOwner === "string" &&
    typeof s.repoName === "string" &&
    typeof s.prNumber === "number" &&
    typeof s.headSha === "string"
  );
}

function parseEntries(
  content: string | undefined,
  format: "json" | "lang",
): Record<string, string> | undefined {
  if (!content || content.trim() === "") return undefined;
  return parseLangFile(content, format).entries;
}

export function createReviewAlignTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    pairs: Type.Array(
      Type.Object({
        mod: Type.Object({
          slug: Type.String({ description: "Mod slug" }),
          gameVersion: Type.String({ description: "Game version" }),
          domain: Type.String({ description: "Mod domain (e.g. asset, mcw)" }),
        }),
        path: Type.String({ description: "Changed file path (e.g. projects/1.20.1/.../zh_cn.json)" }),
        baseEnContent: Type.Optional(Type.String({ description: "Raw content of en_us at base ref" })),
        headEnContent: Type.Optional(Type.String({ description: "Raw content of en_us at head ref" })),
        baseZhContent: Type.Optional(Type.String({ description: "Raw content of zh_cn at base ref" })),
        headZhContent: Type.Optional(Type.String({ description: "Raw content of zh_cn at head ref" })),
        format: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("lang")], { description: "Language file format, default json" })),
      }),
      { description: "Array of language file pairs to align" },
    ),
    scope: Type.Object({
      repoOwner: Type.String({ description: "Repository owner" }),
      repoName: Type.String({ description: "Repository name" }),
      prNumber: Type.Number({ description: "PR number" }),
      headSha: Type.String({ description: "Head SHA of the PR" }),
    }),
  });

  return {
    name: "review_align",
    label: "对齐语言条目",
    description:
      "按 key 对齐一个或多个 mod 的 EN/ZH 语言条目（base + head），检测程序候选（缺失/孤立/空/陈旧/未翻译/格式/占位符不匹配），把结果写入 ctx.aligned。输入为每个 pair 的原始文件内容字符串（从 pr_read_file 获取后传入）和固定的 PR scope。**全部 pair 对齐完再进下一步**（渐进披露只影响 review_moa 分桶，不影响对齐）。**对齐结果自动按 (mod, key, 英文原文) 合并跨版本条目**：同一 key 多版本合并为一条（多 zh 全保留、zhVariant 标记版本间差异），review_moa 审一次覆盖全部版本；程序候选同步合并去重。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isReviewAlignParams(params) ? params : null;
      if (!p) {
        const err = { ok: false, error: "无效参数：需要 pairs[] 和 scope { repoOwner, repoName, prNumber, headSha }" };
        return {
          content: [{ type: "text", text: JSON.stringify(err) }],
          details: err,
        };
      }

      const ctx: Ctx = getSessionCtx(sessionId);
      const existing = (ctx.aligned as unknown as AlignReviewItemsResult[]) ?? [];
      const results: AlignReviewItemsResult[] = [];
      let totalItems = 0;
      let totalCandidates = 0;
      const errors: { path: string; error: string }[] = [];

      for (const pair of p.pairs) {
        try {
          const format = pair.format ?? "json";
          const input: AlignReviewItemsInput = {
            baseEn: parseEntries(pair.baseEnContent, format),
            headEn: parseEntries(pair.headEnContent, format),
            baseZh: parseEntries(pair.baseZhContent, format),
            headZh: parseEntries(pair.headZhContent, format),
            mod: pair.mod,
            path: pair.path,
            scope: p.scope,
          };
          const result = alignLangReviewItems(input);
          results.push(result);
          totalItems += result.items.length;
          totalCandidates += result.candidates.length;
        } catch (err) {
          errors.push({ path: pair.path, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // 按 path 替换旧行: 同一 pair 重跑不累积(与 review_manual_align 一致)。
      // 无 items 的空结果无法定位 path, 保留原样(不替换也不删除)。
      const pairPaths = new Set(p.pairs.map((pair) => pair.path));
      const kept = existing.filter((res) => {
        const path = res.items?.[0]?.path;
        return path === undefined || !pairPaths.has(path);
      });
      const merged = [...kept, ...results];

      // 跨版本合并(2026-08-03): 同 (slug, domain, key, headEn) 的条目合并为一条,
      // 多版本 zh 全保留(zhVariant 标记差异); 程序候选 itemId 重映射到合并 id。
      // ctx.aligned 存合并视图(单元素), 消费方遍历形状不变; 旧会话未合并形状
      // 经 mergeAlignedItems 同样归一(旧元素也是 {items,candidates})。
      const mergedView = mergeAlignedItems(merged, p.scope);
      const alignedPayload = [{ items: mergedView.items, candidates: mergedView.candidates }];

      setSessionCtx(sessionId, { ...ctx, aligned: alignedPayload as unknown as Record<string, unknown> });
      // 增量持久化：对齐结果立即落盘（契约 2026-08-01）。
      await persistSessionCtx(sessionId);

      const summary = {
        ok: true,
        processedPairs: results.length,
        totalItems,
        totalCandidates,
        mergedItems: mergedView.items.length,
        mergedCandidates: mergedView.candidates.length,
        errors,
        ctxAlignedKeys: alignedPayload.length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: summary,
      };
    },
  };
}
