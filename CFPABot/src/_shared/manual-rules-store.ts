// src/_shared/manual-rules-store.ts
// 全局手册提取规则存储(config/manual-rules.json)。
//
// 文件结构:
//   { "version": 1, "rules": [{ name, match, extract: { mode, keyFrom?, regex? } }] }
//
// 写入必须经 writeJsonLocked(原子写 + Windows EPERM 重试 + 进程级锁);
// 读取失败/文件缺失一律视为空规则集, 不抛错。
//
// 用途: manual_rule_promote Flow 写; review_manual_plan 工具 set/get 时读取
// 并与 session 规则合并(session 同名覆盖全局, 见 mergeManualRules)。

import { readJsonFile, writeJsonLocked } from "./fs-utils.js";
import type { ManualRule } from "../flows/_shared/manual-extract.js";

export const MANUAL_RULES_PATH = "config/manual-rules.json";

export interface ManualRulesFile {
  version: 1;
  rules: ManualRule[];
}

function isLooseRuleShape(x: unknown): x is ManualRule {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    r.name.trim() !== "" &&
    typeof r.match === "string" &&
    typeof r.extract === "object" &&
    r.extract !== null &&
    typeof (r.extract as Record<string, unknown>).mode === "string"
  );
}

/**
 * 读取全局规则。文件缺失/损坏/字段不完整 → 返回空数组(损坏场景丢弃整组,
 * 避免半结构数据流入对齐; 可重跑 promote 重建)。
 */
export async function loadGlobalManualRules(): Promise<ManualRule[]> {
  const file = await readJsonFile<ManualRulesFile>(MANUAL_RULES_PATH);
  if (!file || !Array.isArray(file.rules)) return [];
  return file.rules.filter(isLooseRuleShape);
}

/** 原子写入全局规则文件。 */
export async function saveGlobalManualRules(rules: ManualRule[]): Promise<void> {
  const payload: ManualRulesFile = { version: 1, rules };
  await writeJsonLocked(MANUAL_RULES_PATH, payload);
}
