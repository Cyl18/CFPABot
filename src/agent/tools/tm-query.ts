// src/agent/tools/tm-query.ts
// Custom tool: tm_query — 翻译记忆(TM)查询。
// 读取 tm_build Flow 生成的 runtime/cache/tm/{slug}.json 索引(工具无 FlowContext,
// 直接读缓存文件), 用 BM25 相关性或编辑距离模糊匹配召回候选译法。
// 同一英文词条的不同译法(zh)全部返回——多译法候选是审查重点。
//
// 索引不存在时返回明确错误, 提示先调用 tm_build。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readJsonFile } from "../../_shared/fs-utils.js";
import { tmIndexPath } from "../../runtime-paths.js";
import {
  searchTm,
  fuzzyFind,
  type TmIndexFile,
  type TmHit,
} from "../../flows/_shared/terminology/index.js";

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_DIST = 2;

export interface TmQueryParams {
  slug: string;
  query: string;
  op?: "bm25" | "fuzzy" | "both";
  topK?: number;
}

function isTmQueryParams(x: unknown): x is TmQueryParams {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return typeof p.slug === "string" && typeof p.query === "string";
}

export function createTmQueryTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    slug: Type.String({ description: "Mod slug, 对应 tm_build 构建的索引(如 twilightforest)" }),
    query: Type.String({ description: "查询文本(英文原文或错拼近似词)" }),
    op: Type.Optional(
      Type.Union(
        [Type.Literal("bm25"), Type.Literal("fuzzy"), Type.Literal("both")],
        { description: "检索方式: bm25=相关性排序, fuzzy=编辑距离模糊, both=两者都返回, 默认 both" },
      ),
    ),
    topK: Type.Optional(
      Type.Number({ description: "每种检索返回条数上限, 默认 5" }),
    ),
  });

  return {
    name: "tm_query",
    label: "翻译记忆查询",
    description:
      "查询翻译记忆(TM)索引(由 tm_build 构建): bm25 按相关性召回, fuzzy 按编辑距离召回错拼/近似词," +
      "同一英文的不同译法全部返回供审查对比。索引不存在时请先调用 tm_build 构建。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isTmQueryParams(params) ? params : null;
      if (!p) {
        const err = { ok: false, error: "无效参数：需要 slug 和 query" };
        return {
          content: [{ type: "text", text: JSON.stringify(err) }],
          details: err,
        };
      }

      const file = await readJsonFile<TmIndexFile>(tmIndexPath(p.slug));
      if (!file || !file.index) {
        const err = { ok: false, error: "TM 索引不存在, 请先调用 tm_build" };
        return {
          content: [{ type: "text", text: JSON.stringify(err) }],
          details: err,
        };
      }

      const op = p.op === "bm25" || p.op === "fuzzy" ? p.op : "both";
      const topK = typeof p.topK === "number" && p.topK > 0 ? p.topK : undefined;

      const bm25Hits: TmHit[] =
        op !== "fuzzy" ? searchTm(file.index, p.query, { topK: topK ?? DEFAULT_TOP_K }) : [];
      const fuzzyHits: TmHit[] =
        op !== "bm25" ? fuzzyFind(file.index, p.query, { maxDist: DEFAULT_MAX_DIST, topK: topK ?? DEFAULT_TOP_K }) : [];

      const result = {
        ok: true,
        op,
        slug: p.slug,
        hits: bm25Hits,
        fuzzyHits,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
