// src/flows/_shared/language/checks.ts
// PURE: 确定性检查注册表 — 13 个程序检查的元数据(id/label/severity/类别)
// + 忽略机制(全局 defaultDisabled / 条目级规则)。Weblate checks 注册表
// (BaseCheck + ClassLoader)的轻量落地: 本项目是静态数组即可, 不引入懒加载。
//
// 执行逻辑不在注册表内:
// - format 类 8 项 → format-checks.ts 的 checkEntryFormat
// - align 类 5 项 → align-review-items.ts 四值对齐状态机
// 注册表只提供统一的元数据与开关语义, 供 MoA prompt 渲染、忽略配置、聚合去重消费。

import type { ProgramCandidate, ProgramIssueType } from "./align-review-items.js";

export type CheckCategory = "align" | "format";

export interface CheckMeta {
  /** 检查 id, 即 ProgramIssueType */
  id: ProgramIssueType;
  /** 中文描述(MoA prompt 渲染用) */
  label: string;
  severity: "error" | "warning";
  category: CheckCategory;
  /** 忽略三层之全局层: 默认禁用的检查须显式启用才运行(新检查不打扰存量) */
  defaultDisabled?: boolean;
}

/** 13 个程序检查全量注册。severity 与实际候选产出对齐(见 align-review-items / format-checks)。 */
export const CHECK_REGISTRY: readonly CheckMeta[] = [
  // ── align 类(四值对齐状态机) ──
  { id: "missing_translation", label: "缺失翻译(en_us 有 key 但 zh_cn 无)", severity: "error", category: "align" },
  { id: "orphan_translation", label: "孤儿翻译(zh_cn 有 key 但 en_us 无)", severity: "warning", category: "align" },
  { id: "empty_value", label: "空翻译值(zh_cn 为空串)", severity: "warning", category: "align" },
  { id: "stale_translation", label: "过期翻译(en 已变更而 zh 未更新)", severity: "warning", category: "align" },
  { id: "untranslated_value", label: "未翻译(zh 与 en 相同)", severity: "warning", category: "align" },
  // ── format 类(确定性格式检查) ──
  { id: "placeholder_count_mismatch", label: "占位符数量不一致(%s/{0}/%msg%)", severity: "error", category: "format" },
  { id: "special_tag_mismatch", label: "格式标签数量不一致(§/& 色码/HTML/换行)", severity: "error", category: "format" },
  { id: "tellraw_mismatch", label: "tellraw JSON 非 text 键被修改", severity: "error", category: "format" },
  { id: "music_disc_translated", label: "唱片名被翻译(应保留原文)", severity: "warning", category: "format" },
  { id: "punctuation_issue", label: "标点规范(半角/间距/尾空格)", severity: "warning", category: "format" },
  { id: "energy_unit_translated", label: "能量/体积单位被翻译(FE/RF/MB)", severity: "error", category: "format" },
  { id: "ellipsis_issue", label: "省略号用法(三个英文句号)", severity: "warning", category: "format" },
  { id: "subtitle_format_issue", label: "声音字幕格式(主体：声音)", severity: "warning", category: "format" },
];

const REGISTRY_BY_ID: Record<string, CheckMeta> = Object.fromEntries(
  CHECK_REGISTRY.map((m) => [m.id, m]),
);

/** 查询单个检查元数据(未注册返回 undefined)。 */
export function getCheckMeta(id: string): CheckMeta | undefined {
  return REGISTRY_BY_ID[id];
}

/**
 * 全局层开关: 默认启用 + defaultDisabled 需显式启用 + overrides 覆盖。
 * overrides 语义: { [checkId]: true|false } 显式开/关; "all" 表示全量启用(含 defaultDisabled)。
 */
export function isCheckEnabled(
  id: string,
  overrides?: { all?: boolean; [checkId: string]: boolean | undefined },
): boolean {
  if (overrides?.all) return true;
  const explicit = overrides?.[id];
  if (explicit !== undefined) return explicit;
  return !getCheckMeta(id)?.defaultDisabled;
}

// ─── 条目级忽略规则(忽略三层之条目层) ─────────────────────────────────

export interface CheckIgnoreRule {
  /** 生效的检查 id 列表; 空/缺省 = 对全部检查生效 */
  checkIds?: string[];
  /** path 前缀(如 "projects/1.20.1/assets/foo/") */
  pathPrefix?: string;
  /** key 前缀(如 "book.", "patchouli.") */
  keyPrefix?: string;
}

/**
 * 按条目级规则过滤候选: 命中规则(path/key 前缀 + 检查 id 匹配)的候选被豁免。
 * 纯函数, 不改变输入。调用方不传规则 = 不过滤(现状行为不变)。
 */
export function applyCheckIgnores(
  candidates: ProgramCandidate[],
  rules: CheckIgnoreRule[],
): ProgramCandidate[] {
  if (rules.length === 0) return candidates;
  return candidates.filter((c) => {
    const rule = rules.find(
      (r) =>
        (!r.checkIds || r.checkIds.length === 0 || r.checkIds.includes(c.issueType)) &&
        (!r.pathPrefix || c.path?.startsWith(r.pathPrefix)) &&
        (!r.keyPrefix || c.key?.startsWith(r.keyPrefix)),
    );
    return rule === undefined;
  });
}
