// src/flows/_shared/manual-dsl.ts
// Pure 手册对齐 DSL(version 1/2)的 YAML 解析/序列化与计划分析。无 I/O。
//
// 计划 YAML 形状(version 2):
//   version: 2
//   pairs:                       # 必填(v1 兼容字段)
//     - path: projects/1.20.1/foo/docs/guide.md
//       slug: foo
//       gameVersion: 1.20.1
//       reviewNote: ...
//   notes: |                     # 可选
//     ...
//   rules:                       # v2 新增, 可选
//     - name: guide-headings
//       match: projects/**/guide.md
//       extract:
//         mode: markdown-heading
//         keyFrom: heading
//     - name: version-tags
//       match: "**/CHANGELOG.md"
//       extract:
//         mode: regex
//         keyFrom: group
//         regex: "/^##?\\s+\\[(v[0-9.]+)\\]/gm"
//
// 解析器是行级最小实现: 不处理流式([]/{})、引号转义、锚点/别名。
// 支持两种列表项写法: `- key: value`(inline) 与 `-` 换行后 `key: value`。
// rules 的 extract 是嵌套映射(下一层 key: mode/keyFrom/regex)。

import {
  globMatch,
  validateManualRules,
  type ManualExtractedEntry,
  type ManualRule,
} from "./manual-extract.js";

// ─── Plan types ───────────────────────────────────────────────────────

export interface ManualPairEntry {
  path: string;
  slug?: string;
  gameVersion?: string;
  reviewNote?: string;
}

export interface ManualPlan {
  version: 1 | 2;
  pairs: ManualPairEntry[];
  notes?: string;
  rules?: ManualRule[];
}

export interface ParsePlanOptions {
  /** pairs 为空时报错(默认 true; promote 解析仅 rules 段时传 false)。 */
  requirePairs?: boolean;
  /** rules 为空时报错(默认 false)。 */
  requireRules?: boolean;
}

// ─── YAML 解析 ────────────────────────────────────────────────────────

// 解析中间态: YAML 文本里的字段值是任意字符串, 语义校验在收集后统一做。
interface LoosePair {
  path?: string;
  slug?: string;
  gameVersion?: string;
  reviewNote?: string;
}

interface LooseExtract {
  mode?: string;
  keyFrom?: string;
  regex?: string;
}

interface LooseRule {
  name?: string;
  match?: string;
  extract?: LooseExtract;
}

const PAIR_FIELDS = new Set(["path", "slug", "gameVersion", "reviewNote"]);
const RULE_FIELDS = new Set(["name", "match", "extract"]);
const EXTRACT_FIELDS = new Set(["mode", "keyFrom", "regex"]);

/** 剥离成对的外层单/双引号(最小实现, 不做转义/拼接处理)。 */
function unquoteScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 解析计划 YAML。语法/语义错误全部收集进 errors; 有错误时返回 plan=null。
 * version 兼容: 显式 version: 1 且带 rules → 报错; 未写 version 但带 rules →
 * 自动按 version 2 处理; 显式 version: 2 任意。
 */
export function parseManualPlanYaml(
  raw: string,
  opts: ParsePlanOptions = {},
): { plan: ManualPlan | null; errors: string[] } {
  const { requirePairs = true, requireRules = false } = opts;
  const errors: string[] = [];
  const plan: ManualPlan = { version: 1, pairs: [], rules: [] };

  let current: LoosePair | LooseRule | null = null;
  let currentIsRule = false;
  let inRuleExtract = false;
  let pendingBareItem = false;
  let inNotes = false;
  let notesIndent = -1;
  let notesLines: string[] = [];
  let versionExplicit = false;

  const finishItem = (lineNo: number) => {
    if (!current) return;
    if (currentIsRule) {
      const rule = current as LooseRule;
      if (rule.name) plan.rules!.push(rule as unknown as ManualRule);
      else errors.push(`L${lineNo}: 上一个 rule 缺少 name, 已丢弃`);
    } else {
      const pair = current as LoosePair;
      if (pair.path) plan.pairs.push(pair as unknown as ManualPairEntry);
      else errors.push(`L${lineNo}: 上一个 pair 缺少 path, 已丢弃`);
    }
    current = null;
    inRuleExtract = false;
  };

  const startItem = (isRule: boolean): LoosePair | LooseRule => {
    const item = isRule ? ({} as LooseRule) : ({} as LoosePair);
    current = item;
    currentIsRule = isRule;
    inRuleExtract = false;
    return item;
  };

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const lineNo = i + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = (rawLine.match(/^(\s*)/)?.[1] ?? "").length;

    // notes 块续行(缩进大于 notes 行本身)
    if (inNotes) {
      if (indent <= notesIndent && trimmed !== "") {
        inNotes = false;
        plan.notes = notesLines.join("\n").trim();
        notesLines = [];
      } else {
        notesLines.push(trimmed);
        continue;
      }
    }

    const dashM = trimmed.match(/^-\s*(.*)$/);
    if (dashM) {
      // ── 列表项 `- ...`(dash 之后可能是 inline 字段或裸 `-`) ──
      finishItem(lineNo);
      const inline = dashM[1]!.trim();
      if (inline === "") {
        pendingBareItem = true;
        continue;
      }
      pendingBareItem = false;
      const fieldM = inline.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
        if (!fieldM) {
          errors.push(`L${lineNo}: 无法解析列表项 "${trimmed}"`);
          continue;
        }
        const fk = fieldM[1]!;
        const fv = unquoteScalar(fieldM[2]!.trim());
        if (fk === "path") {
          (startItem(false) as LoosePair).path = fv;
        } else if (fk === "name") {
          (startItem(true) as LooseRule).name = fv;
        } else {
          errors.push(`L${lineNo}: 列表项首字段必须是 path(pairs)或 name(rules), 得到 "${fk}"`);
        }
      continue;
    }

    const m = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!m) {
      errors.push(`L${lineNo}: 无法解析 "${trimmed}"`);
      continue;
    }
    const key = m[1]!;
    const value = unquoteScalar(m[2]!.trim());

    // ── 顶层键(indent 0) ──
    if (indent === 0) {
      finishItem(lineNo);
      pendingBareItem = false;
      if (key === "version") {
        versionExplicit = true;
        if (value === "1") {
          plan.version = 1;
        } else if (value === "2") {
          plan.version = 2;
        } else {
          errors.push(`L${lineNo}: version 必须为 1 或 2, 得到 "${value}"`);
        }
      } else if (key === "notes") {
        if (value === "|" || value === "|-") {
          inNotes = true;
          notesIndent = indent;
          notesLines = [];
        } else if (value.length > 0) {
          plan.notes = value;
        }
      } else if (key === "pairs") {
        if (value !== "" && value !== "[]") {
          errors.push(`L${lineNo}: pairs 应该是一个列表, 行首不要写值`);
        }
      } else if (key === "rules") {
        if (value !== "" && value !== "[]") {
          errors.push(`L${lineNo}: rules 应该是一个列表, 行首不要写值`);
        }
      } else {
        errors.push(`L${lineNo}: 意外顶层字段 "${key}"`);
      }
      continue;
    }

    // ── 字段行 ──
    // 裸 `-` 之后的第一行决定条目类型: pair 字段 → pair; rule/extract 字段 → rule。
    if (pendingBareItem) {
      pendingBareItem = false;
      if (PAIR_FIELDS.has(key)) {
        startItem(false);
      } else if (RULE_FIELDS.has(key)) {
        startItem(true);
      } else {
        errors.push(`L${lineNo}: 列表项首字段必须是 path(pairs)或 name(rules), 得到 "${key}"`);
        continue;
      }
    }

    if (!current) {
      errors.push(`L${lineNo}: 意外字段 "${key}"(必须在 pairs/rules 列表内)`);
      continue;
    }

    if (currentIsRule) {
      const rule = current as LooseRule;
      if (inRuleExtract) {
        const extract = rule.extract ?? (rule.extract = {});
        if (key === "mode") extract.mode = value;
        else if (key === "keyFrom") extract.keyFrom = value;
        else if (key === "regex") extract.regex = value;
        else errors.push(`L${lineNo}: extract 意外字段 "${key}"(允许: mode/keyFrom/regex)`);
      } else if (key === "name") {
        rule.name = value;
      } else if (key === "match") {
        rule.match = value;
      } else if (key === "extract") {
        inRuleExtract = true;
      } else {
        errors.push(`L${lineNo}: rule 意外字段 "${key}"(允许: name/match/extract)`);
      }
      continue;
    }

    const pair = current as LoosePair;
    if (key === "path") pair.path = value;
    else if (key === "slug") pair.slug = value;
    else if (key === "gameVersion") pair.gameVersion = value;
    else if (key === "reviewNote") pair.reviewNote = value;
    else errors.push(`L${lineNo}: pair 意外字段 "${key}"(允许: path/slug/gameVersion/reviewNote)`);
  }

  finishItem(lines.length);
  if (inNotes) {
    plan.notes = notesLines.join("\n").trim();
  }

  // ── 语义校验 ──
  if (requirePairs && plan.pairs.length === 0) {
    errors.push("plan 中至少需要一个 pair");
  }
  const hasRules = (plan.rules?.length ?? 0) > 0;
  if (requireRules && !hasRules) {
    errors.push("计划中没有 rules — 手册对齐需要至少一条提取规则");
  }
  // 未显式写 version 但带 rules → 自动升级为 2(仅 rules 段/裸列表场景)。
  if (hasRules && !versionExplicit) {
    plan.version = 2;
  }
  if (versionExplicit && plan.version === 1 && hasRules) {
    errors.push("version: 1 不支持 rules, 请改用 version: 2");
  }
  if (hasRules) {
    errors.push(...validateManualRules(plan.rules!));
  }

  return { plan: errors.length === 0 ? plan : null, errors };
}

/**
 * 仅解析规则(供 manual_rule_promote 使用): 接受完整 v2 计划 YAML,
 * 或以 `rules:` 开头的 rules 段, 或直接以 `- ` 开头的裸规则列表。
 */
export function parseManualRulesYaml(raw: string): { rules: ManualRule[]; errors: string[] } {
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  const isBareList = firstLine !== undefined && firstLine.startsWith("- ");
  const source = isBareList ? `rules:\n${raw}` : raw;
  const r = parseManualPlanYaml(source, { requirePairs: false, requireRules: true });
  return { rules: r.plan?.rules ?? [], errors: r.errors };
}

// ─── YAML 序列化 ──────────────────────────────────────────────────────

/** 序列化计划(version 2 时含 rules)。 */
export function emitManualPlanYaml(plan: ManualPlan): string {
  const lines: string[] = [`version: ${plan.version}`, ""];
  if (plan.notes) {
    lines.push("notes: |");
    for (const nl of plan.notes.split("\n")) {
      lines.push(`  ${nl}`);
    }
    lines.push("");
  }
  lines.push("pairs:");
  for (const p of plan.pairs) {
    lines.push(`  - path: ${p.path}`);
    if (p.slug) lines.push(`    slug: ${p.slug}`);
    if (p.gameVersion) lines.push(`    gameVersion: ${p.gameVersion}`);
    if (p.reviewNote) lines.push(`    reviewNote: ${p.reviewNote}`);
  }
  const rules = plan.rules ?? [];
  if (rules.length > 0) {
    lines.push("rules:");
    for (const r of rules) {
      lines.push(`  - name: ${r.name}`);
      lines.push(`    match: ${r.match}`);
      lines.push("    extract:");
      lines.push(`      mode: ${r.extract.mode}`);
      if (r.extract.keyFrom) lines.push(`      keyFrom: ${r.extract.keyFrom}`);
      if (r.extract.regex) lines.push(`      regex: ${r.extract.regex}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ─── 覆盖分析(dry-run 用, 纯函数) ─────────────────────────────────────

export interface RuleCoverage {
  rule: ManualRule;
  /** 按输入 paths 顺序命中的文件。 */
  matchedFiles: string[];
  /** 第一个命中文件(pairs 顺序)。 */
  firstFile?: string;
}

export interface CoverageConflict {
  path: string;
  /** 命中的规则名, 按 rules 顺序; 第一个生效。 */
  matchedBy: string[];
  /** 生效(第一个)规则名。 */
  winner: string;
}

/**
 * 计算每条 rule 命中的文件 + 同一文件被多条 rule 命中的冲突。
 * 冲突语义: 匹配时按 rules 数组顺序取第一个生效。
 */
export function analyzeRuleCoverage(
  rules: ManualRule[],
  paths: string[],
): { perRule: RuleCoverage[]; conflicts: CoverageConflict[] } {
  const perRule: RuleCoverage[] = rules.map((rule) => {
    const matchedFiles = paths.filter((p) => globMatch(rule.match, p));
    return { rule, matchedFiles, firstFile: matchedFiles[0] };
  });
  const conflicts: CoverageConflict[] = [];
  for (const path of paths) {
    const matchedBy = rules.filter((r) => globMatch(r.match, path)).map((r) => r.name);
    if (matchedBy.length > 1) {
      conflicts.push({ path, matchedBy, winner: matchedBy[0]! });
    }
  }
  return { perRule, conflicts };
}

/** 合并规则: 全局在前, session 同名覆盖(按 name)。 */
export function mergeManualRules(
  sessionRules: ManualRule[] | undefined,
  globalRules: ManualRule[] | undefined,
): ManualRule[] {
  const merged = new Map<string, ManualRule>();
  for (const r of globalRules ?? []) merged.set(r.name, r);
  for (const r of sessionRules ?? []) merged.set(r.name, r);
  return [...merged.values()];
}

export type { ManualExtractedEntry };
