// src/flows/manual/manual_rule_promote.ts
// Flow: manual_rule_promote — 校验并合并手册提取规则到全局配置。
// Risk: repository_write | Effects: storage_write
//
// 输入 yaml: 完整 v2 计划 YAML(取其中 rules)或仅 rules 段
// (`rules:` 开头, 或直接以 `- ` 开头的裸规则列表)。
// 校验: mode 白名单(markdown-heading|line-table|kv-json|regex)、glob 合法、
// name 唯一(输入内 + 不与 config/manual-rules.json 已有规则重名)。
// 通过后合并写入 config/manual-rules.json(writeJsonLocked 原子写):
//   { "version": 1, "rules": [{ name, match, extract: { mode, keyFrom?, regex? } }] }
// 全局规则在 review_manual_plan(op=set/get)时与 session 规则合并
// (session 同名优先); 本 Flow 本身不写 session ctx。
// repository_write → flow-adapter 走 admin 确认。

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { parseManualRulesYaml } from "../_shared/manual-dsl.js";
import { loadGlobalManualRules, saveGlobalManualRules } from "../../_shared/manual-rules-store.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const manual_rule_promote_input = Type.Object({
  yaml: Type.String({
    description:
      "完整 v2 计划 YAML(取其中 rules)或仅 rules 段: 以 `rules:` 开头的列表, 或直接以 `- ` 开头的裸规则列表",
  }),
});

export type ManualRulePromoteInput = Static<typeof manual_rule_promote_input>;

// ─── Output Schema ─────────────────────────────────────────────────────

export const manual_rule_promote_output = Type.Object({
  ok: Type.Boolean({ description: "是否成功" }),
  promoted: Type.Array(Type.String(), { description: "本次晋升的规则名(已合并进全局)" }),
  totalRules: Type.Number({ description: "合并后 config/manual-rules.json 的规则总数" }),
});

export type ManualRulePromoteOutput = Static<typeof manual_rule_promote_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const manual_rule_promote: Flow<
  typeof manual_rule_promote_input,
  typeof manual_rule_promote_output
> = {
  name: "manual_rule_promote",
  description:
    "校验并晋升手册提取规则到全局(config/manual-rules.json): mode 白名单 + glob 合法 + name 唯一" +
    "(输入内及与全局不重名)。晋升后 review_manual_plan 的 set/get 会读取全局规则并合并到 session。" +
    "风险为 repository_write, 需要 admin 确认。",
  input: manual_rule_promote_input,
  output: manual_rule_promote_output,
  meta: {
    tags: ["manual", "rules", "config"],
    risk: "repository_write",
    effects: ["storage_write"],
    agent_callable: true,
    timeoutMs: 30_000,
  },

  async execute(
    _ctx: FlowContext,
    input: Static<typeof manual_rule_promote_input>,
  ): Promise<Static<typeof manual_rule_promote_output>> {
    const { rules, errors } = parseManualRulesYaml(input.yaml);
    if (errors.length > 0 || rules.length === 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `manual_rule_promote: 规则校验失败\n${errors.join("\n")}`,
        publicMessage: `规则校验失败: ${errors.join("; ") || "没有可晋升的规则"}`,
        retryable: false,
        details: { errors },
      });
    }

    const existing = await loadGlobalManualRules();
    const existingNames = new Set(existing.map((r) => r.name));
    const dupes = rules.filter((r) => existingNames.has(r.name));
    if (dupes.length > 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `规则名与全局已存在冲突: ${dupes.map((r) => r.name).join(", ")}`,
        publicMessage: `规则名已存在于 config/manual-rules.json: ${dupes.map((r) => r.name).join(", ")} — 请改名后再晋升`,
        retryable: false,
        details: { dupes: dupes.map((r) => r.name) },
      });
    }

    const merged = [...existing, ...rules];
    await saveGlobalManualRules(merged);
    return {
      ok: true,
      promoted: rules.map((r) => r.name),
      totalRules: merged.length,
    };
  },
};
