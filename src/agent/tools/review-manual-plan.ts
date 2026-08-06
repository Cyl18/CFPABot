// src/agent/tools/review-manual-plan.ts
// Custom tool: review_manual_plan — DSL YAML for describing file-pair review
// plans the agent can edit and commit. Provides validation/loading of the
// plan. Content read from PR files can also feed MoA or a separate minimal
// manual review path.
//
// version 1(兼容): pairs/notes, 无 rules。
// version 2: 新增 rules 数组(提取规则, 见 flows/_shared/manual-extract.ts)。
// op=dry-run: 预览每条 rule 的文件匹配数 + 样例提取(需 contents 提供 head
// 内容)+ 冲突检测(同一文件被多条 rule 命中时按 rules 顺序取第一个生效)。
// op=set/get 会与全局规则(config/manual-rules.json)合并: session 规则优先,
// 同名覆盖全局。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx, type Ctx } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";
import {
  analyzeRuleCoverage,
  emitManualPlanYaml,
  mergeManualRules,
  parseManualPlanYaml,
  type ManualPairEntry,
  type ManualPlan,
} from "../../flows/_shared/manual-dsl.js";
import {
  extractManualEntries,
  type ManualExtractedEntry,
  type ManualRule,
} from "../../flows/_shared/manual-extract.js";
import { loadGlobalManualRules } from "../../_shared/manual-rules-store.js";

export type { ManualPairEntry, ManualPlan };

/** ctx.manualPlan 的运行时形态(比 session-ctx.ts 的类型多了 rules 字段;
 * 通过 as 断言写入, 不修改 session-ctx.ts)。 */
export interface ManualPlanCtx {
  yaml?: string;
  pairs?: ManualPairEntry[];
  notes?: string;
  rules?: ManualRule[];
}

export interface ReviewManualPlanParams {
  op: "set" | "get" | "validate" | "load" | "dry-run";
  yaml?: string;
  /** op=dry-run 可选: path → head 文件内容, 用于样例提取。 */
  contents?: Record<string, string>;
}

function isReviewManualPlanParams(x: unknown): ReviewManualPlanParams | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  if (p.op === "set" && typeof p.yaml === "string") return { op: "set", yaml: p.yaml };
  if (p.op === "get") return { op: "get" };
  if (p.op === "validate" && typeof p.yaml === "string") return { op: "validate", yaml: p.yaml };
  if (p.op === "load") return { op: "load" };
  if (p.op === "dry-run" && typeof p.yaml === "string") {
    const contents =
      p.contents !== undefined && p.contents !== null && typeof p.contents === "object"
        ? (p.contents as Record<string, string>)
        : undefined;
    return { op: "dry-run", yaml: p.yaml, contents };
  }
  return null;
}

function readPlanCtx(ctx: Ctx): ManualPlanCtx | undefined {
  return ctx.manualPlan as ManualPlanCtx | undefined;
}

const SAMPLE_LIMIT = 3;
const SAMPLE_VALUE_MAX = 120;

function sampleEntries(entries: ManualExtractedEntry[]): Record<string, unknown>[] {
  return entries.slice(0, SAMPLE_LIMIT).map((e) => {
    const value =
      e.value !== undefined && e.value.length > SAMPLE_VALUE_MAX
        ? `${e.value.slice(0, SAMPLE_VALUE_MAX)}…(${e.value.length} chars)`
        : e.value;
    return { key: e.key, value, span: e.span };
  });
}

export function createReviewManualPlanTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    op: Type.Union(
      [
        Type.Literal("set"),
        Type.Literal("get"),
        Type.Literal("validate"),
        Type.Literal("load"),
        Type.Literal("dry-run"),
      ],
      {
        description:
          "set=解析并保存 yaml(含全局规则合并), get=读取当前(含全局规则合并), validate=仅校验不保存, load=生成 ctx-ready pairs, dry-run=规则覆盖预览+样例提取+冲突检测",
      },
    ),
    yaml: Type.Optional(Type.String({ description: "op=set/validate/dry-run 时的 plan YAML 字符串" })),
    contents: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "op=dry-run 可选: path → head 文件内容, 用于样例提取",
      }),
    ),
  });

  return {
    name: "review_manual_plan",
    label: "Manual DSL Plan",
    description:
      "描述文件配对的 DSL YAML 计划。version 1: pairs/notes; version 2 增加 rules(提取规则)。" +
      "op=set 解析并写入 ctx.manualPlan(覆盖, 与 config/manual-rules.json 全局规则合并, session 同名优先); " +
      "op=get 返回当前 plan; op=validate 仅校验不保存; op=load 生成可传入 review_align 的 pairs; " +
      "op=dry-run 预览规则匹配/样例提取/冲突。YAML 形状: version: 1|2, pairs: [{ path, slug?, gameVersion?, reviewNote? }], " +
      "rules?: [{ name, match, extract: { mode: markdown-heading|line-table|kv-json|regex, keyFrom?, regex? } }], notes?: string。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = isReviewManualPlanParams(params);
      if (!p) {
        const err = { ok: false, error: "无效参数：op 必须是 set|get|validate|load|dry-run 之一" };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }
      const ctx: Ctx = getSessionCtx(sessionId);

      if (p.op === "get") {
        const stored = readPlanCtx(ctx);
        const sessionRules = stored?.rules ?? [];
        const globalRules = await loadGlobalManualRules();
        const rules = mergeManualRules(sessionRules, globalRules);
        const result = {
          ok: true,
          op: "get",
          version: stored ? (stored.rules && stored.rules.length > 0 ? 2 : 1) : null,
          plan: stored ?? null,
          rules,
          globalRuleCount: globalRules.length,
          note: "rules 为全局 + session 合并结果(session 同名覆盖)",
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }

      if (p.op === "validate") {
        const r = parseManualPlanYaml(p.yaml ?? "");
        const result = { ok: r.plan !== null, errors: r.errors, plan: r.plan };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }

      if (p.op === "load") {
        const stored = readPlanCtx(ctx);
        if (!stored || !stored.pairs) {
          const err = { ok: false, error: "ctx.manualPlan 为空或没有 pairs — 请先 set" };
          return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
        }
        const result = {
          ok: true,
          op: "load",
          pairs: stored.pairs.map((pr) => ({
            path: pr.path,
            slug: pr.slug ?? "",
            gameVersion: pr.gameVersion ?? "",
            reviewNote: pr.reviewNote,
          })),
          notes: stored.notes ?? null,
          rules: stored.rules ?? [],
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }

      if (p.op === "dry-run") {
        const r = parseManualPlanYaml(p.yaml ?? "", { requireRules: true });
        if (!r.plan) {
          const err = { ok: false, op: "dry-run", errors: r.errors };
          return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
        }
        const plan = r.plan;
        const paths = plan.pairs.map((pr) => pr.path);
        const { perRule, conflicts } = analyzeRuleCoverage(plan.rules ?? [], paths);
        const rules = perRule.map(({ rule, matchedFiles, firstFile }) => {
          const sampleNote: string | undefined =
            firstFile !== undefined && p.contents?.[firstFile] === undefined
              ? "无 head 内容(contents 缺该 path), 跳过样例提取"
              : undefined;
          let sample: Record<string, unknown>[] = [];
          if (firstFile !== undefined && p.contents?.[firstFile] !== undefined) {
            try {
              sample = sampleEntries(
                extractManualEntries(p.contents![firstFile]!, rule, firstFile),
              );
            } catch (err) {
              return {
                name: rule.name,
                matchedFiles: matchedFiles.length,
                firstFile,
                sample: null,
                sampleError: err instanceof Error ? err.message : String(err),
              };
            }
          }
          return {
            name: rule.name,
            matchedFiles: matchedFiles.length,
            firstFile,
            sample,
            sampleNote,
          };
        });
        const result = {
          ok: true,
          op: "dry-run",
          rules,
          conflicts,
          conflictNote:
            conflicts.length > 0 ? "同一文件被多个 rule 命中: 取 rules 顺序第一个生效" : undefined,
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }

      // op === "set"
      const r = parseManualPlanYaml(p.yaml ?? "");
      if (!r.plan) {
        const err = { ok: false, op: "set", errors: r.errors };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }
      // 全局规则合并: session 同名优先
      const globalRules = await loadGlobalManualRules();
      const effectiveRules = mergeManualRules(r.plan.rules, globalRules);
      const yaml = emitManualPlanYaml(r.plan);
      setSessionCtx(sessionId, {
        ...ctx,
        manualPlan: {
          yaml,
          pairs: r.plan.pairs,
          notes: r.plan.notes,
          rules: effectiveRules,
        } as Ctx["manualPlan"],
      });
      // 增量持久化: 计划与合并后规则立即落盘(契约 2026-08-01)。
      await persistSessionCtx(sessionId);
      const result = {
        ok: true,
        op: "set",
        version: r.plan.version,
        pairs: r.plan.pairs.length,
        rules: effectiveRules.length,
        globalMerged: globalRules.length > 0,
        yamlLength: yaml.length,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}
