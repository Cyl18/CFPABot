// src/agent/tools/review-manual-align.ts
// Custom tool: review_manual_align — 按 ctx.manualPlan.rules 的提取规则,
// 对手册文件对的 zh/en 内容分别提取条目并按 key 对齐, 写入 ctx.manualAligned
// (ManualAlignedRow[]) 并增量落盘。
//
// 规则匹配: 对每个 pair 的 zh 路径, 按 rules 顺序取第一个 glob 命中的规则
// (与 dry-run 的冲突语义一致: 第一个生效)。
// 对齐: en/zh 都有 → 正常行; 只有一侧 → 该侧留空(缺失), 汇总里给出计数与
// 缺失 key 样例, 供 agent 定位。kv-json 条目无 span, 其余 mode 带 1-based 行号。
// ctx.manualAligned 按 path 去重追加: 同一 pair 重跑时替换旧行, 不重复累积。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx, type Ctx, type ManualAlignedRow } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";
import { extractManualEntries, globMatch, type ManualRule } from "../../flows/_shared/manual-extract.js";

export interface ReviewManualAlignPair {
  path: string;
  enPath?: string;
  version?: string;
  domain?: string;
  zhContent?: string;
  enContent?: string;
}

export interface ReviewManualAlignParams {
  pairs: ReviewManualAlignPair[];
}

function isReviewManualAlignParams(x: unknown): ReviewManualAlignParams | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  if (!Array.isArray(p.pairs) || p.pairs.length === 0) return null;
  for (const pair of p.pairs) {
    if (!pair || typeof pair !== "object") return null;
    const pp = pair as Record<string, unknown>;
    if (typeof pp.path !== "string" || pp.path === "") return null;
  }
  return { pairs: p.pairs as ReviewManualAlignPair[] };
}

function readRules(ctx: Ctx): ManualRule[] | undefined {
  return (ctx.manualPlan as { rules?: ManualRule[] } | undefined)?.rules;
}

const MISSING_SAMPLE_MAX = 5;

export function createReviewManualAlignTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    pairs: Type.Array(
      Type.Object({
        path: Type.String({ description: "zh 侧文件路径(手册表展示 key, 也是规则 glob 匹配对象)" }),
        enPath: Type.Optional(Type.String({ description: "en 侧文件路径(默认同 path)" })),
        version: Type.Optional(Type.String({ description: "游戏版本(透传到对齐行)" })),
        domain: Type.Optional(Type.String({ description: "domain(透传到对齐行)" })),
        zhContent: Type.Optional(Type.String({ description: "zh 侧原始文件内容(pr_read_file 获取后传入)" })),
        enContent: Type.Optional(Type.String({ description: "en 侧原始文件内容(pr_read_file 获取后传入)" })),
      }),
      { description: "手册文件对: 至少给 path; zhContent/enContent 至少一侧用于提取" },
    ),
  });

  return {
    name: "review_manual_align",
    label: "手册对齐",
    description:
      "按 ctx.manualPlan.rules 的提取规则(markdown-heading/line-table/kv-json/regex)对手册文件对的 " +
      "zh/en 内容分别提取条目, 按 key 对齐: 两侧都有 → 正常行; 只有一侧 → 缺失(该侧字段留空)。" +
      "结果写入 ctx.manualAligned(ManualAlignedRow[], 按 path 替换旧行)并持久化。" +
      "前置: 先用 review_manual_plan(op=set, version 2 带 rules)设置计划; 无匹配规则时本工具报错。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isReviewManualAlignParams(params);
      if (!p) {
        const err = { ok: false, error: "无效参数：需要非空 pairs[]，每项至少含 path" };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }

      const ctx: Ctx = getSessionCtx(sessionId);
      const rules = readRules(ctx);
      if (!rules || rules.length === 0) {
        const err = {
          ok: false,
          error:
            "ctx.manualPlan.rules 为空 — 请先 review_manual_plan(op=set, version 2 且带 rules)设置提取规则",
        };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }

      const newRows: ManualAlignedRow[] = [];
      const errors: { path: string; error: string }[] = [];
      const perPair: Record<string, unknown>[] = [];
      const pairPaths = new Set(p.pairs.map((pair) => pair.path));

      for (const pair of p.pairs) {
        // 规则匹配: rules 顺序第一个 glob 命中生效
        const rule = rules.find((r) => globMatch(r.match, pair.path));
        if (!rule) {
          errors.push({
            path: pair.path,
            error: `无匹配 rule(match 覆盖不到该路径)— 请 review_manual_plan 补充规则`,
          });
          continue;
        }
        let zhEntries;
        let enEntries;
        try {
          zhEntries = pair.zhContent ? extractManualEntries(pair.zhContent, rule, pair.path) : [];
        } catch (err) {
          errors.push({ path: pair.path, error: `zh 提取失败: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }
        try {
          enEntries = pair.enContent
            ? extractManualEntries(pair.enContent, rule, pair.enPath ?? pair.path)
            : [];
        } catch (err) {
          errors.push({ path: pair.path, error: `en 提取失败: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }

        const zhByKey = new Map(zhEntries.map((e) => [e.key, e]));
        const enByKey = new Map(enEntries.map((e) => [e.key, e]));
        // key 顺序: zh 优先, 再补 en 独有
        const keys = [...new Set([...zhEntries.map((e) => e.key), ...enEntries.map((e) => e.key)])];
        let missingEn = 0;
        let missingZh = 0;
        const missingEnSample: string[] = [];
        const missingZhSample: string[] = [];
        for (const key of keys) {
          const zh = zhByKey.get(key);
          const en = enByKey.get(key);
          if (!en) {
            missingEn++;
            if (missingEnSample.length < MISSING_SAMPLE_MAX) missingEnSample.push(key);
          }
          if (!zh) {
            missingZh++;
            if (missingZhSample.length < MISSING_SAMPLE_MAX) missingZhSample.push(key);
          }
          const zhSpan = zh?.span ?? en?.span;
          newRows.push({
            path: pair.path,
            enPath: pair.enPath,
            version: pair.version,
            domain: pair.domain,
            key,
            en: en?.value,
            zh: zh?.value,
            span: zhSpan,
          });
        }
        perPair.push({
          path: pair.path,
          rule: rule.name,
          rows: keys.length,
          missingEn,
          missingZh,
          missingEnSample,
          missingZhSample,
        });
      }

      // 按 path 替换旧行(重跑不累积), 其余 path 保留
      const existing = (ctx.manualAligned ?? []).filter((row) => !pairPaths.has(row.path));
      const merged = [...existing, ...newRows];
      setSessionCtx(sessionId, { ...ctx, manualAligned: merged });
      // 增量持久化: 对齐结果立即落盘(契约 2026-08-01)。
      await persistSessionCtx(sessionId);

      const result = {
        ok: errors.length === 0,
        processedPairs: p.pairs.length,
        failedPairs: errors.length,
        alignedRows: newRows.length,
        ctxManualAligned: merged.length,
        perPair,
        errors,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}
