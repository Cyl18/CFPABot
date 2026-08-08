// src/flows/_shared/language/format-checks.ts
// PURE: 确定性格式检查（移植自 Minecraft-Translate-Proofread-Agent 的 FormatChecker，
// 2026-08-04）。零 LLM 成本：占位符数量、特殊标签、tellraw、唱片名、标点、能量
// 单位、省略号、字幕格式。与 key-analyzer 平级，供 align 程序候选复用。
// 说明: MTPA 的空翻译/EN=ZH 检查与现有 untranslated_value/empty_value 候选重叠，
// 不重复移植。

// ─── 正则（与 MTPA format_checker.py 对齐）───────────────────────────────

// printf 风格占位符: %d, %s, %f, %1$s, %2$d, %.2f, %+d
const RE_PRINTF = /%[+\-]?\d*\.?\d*[dsf]/g;
const RE_POSITIONAL_PRINTF = /%\d+\$[dsf]/g;
// 其他占位符风格: %msg%, %key%（仅 ASCII 标识符）
const RE_PERCENT_VAR = /%[A-Za-z_]\w*%/g;
const RE_BRACE_VAR = /\{(\d+|[a-zA-Z_]\w*)\}/g;
// Minecraft 格式码: §[0-9a-fk-or] / &[0-9a-f]
const RE_MC_COLOR = /§[0-9a-fA-Fk-oK-OrR]/g;
const RE_ALT_COLOR = /&[0-9a-fA-F]/g;
// 动作占位符: $(l:...) 和 $(action)
const RE_PLACEHOLDER_DOLLAR = /\$\((?:l:[^)]*|[a-zA-Z_]\w*)\)/g;
// HTML/XML 标签、<br>、换行
const RE_HTML_TAG = /<\/?[a-zA-Z_]\w*(?:\s[^>]*)?\/?>/g;
const RE_BR_TAG = /<br\s*\/?>/gi;
const RE_NEWLINE = /\\n|\n/g;
// 能量/体积单位（ASCII 词边界，防中文 \w 干扰）
const ENERGY_UNITS = ["FE", "RF", "MB", "EU", "AE", "kJ", "kW", "kRF"];
const RE_ENERGY_UNIT = new RegExp(`\\b(?:${ENERGY_UNITS.join("|")})\\b`, "g");
// 中文内容检测
const RE_CHINESE_CHAR = /[\u4e00-\u9fff\u3400-\u4dbf]/;
// 省略号: 三个英文句号
const RE_ELLIPSIS_WRONG = /\.{3}/;
// tellraw JSON: 以 {"text": 开头
const RE_TELLRAW = /^\s*\{[^}]*"text"\s*:/;
// 中英文/中文标点间距白名单（Patchouli 手册例外）
const PUNCTUATION_SPACING_WHITELIST = ["book.", "patchouli."];

// ─── 类型 ─────────────────────────────────────────────────────────────────

export type FormatIssueType =
  | "placeholder_count_mismatch" // printf/%msg%/{0} 数量不一致（缺失与多余）
  | "special_tag_mismatch" // §/& 色码、$(action)、HTML、<br>、换行数量
  | "tellraw_mismatch" // tellraw JSON 非 text 键被修改
  | "music_disc_translated" // 唱片名不应翻译
  | "punctuation_issue" // 半角标点/间距/尾空格（建议级）
  | "energy_unit_translated" // FE/RF/MB 等被翻译
  | "ellipsis_issue" // 三个英文句号 ...
  | "subtitle_format_issue"; // 声音字幕缺 主体：声音

export interface FormatCheckFinding {
  issueType: FormatIssueType;
  severity: "error" | "warning";
  detail: string;
  /** 结构化差异: 缺失的占位符/标签/单位(Weblate check_format 同构, MoA prompt 可直接渲染) */
  missing?: string[];
  /** 结构化差异: 多余的占位符/标签/单位 */
  extra?: string[];
}

// ─── 工具 ─────────────────────────────────────────────────────────────────

/** %1$s → %s（位置占位符归一化，用于数量比较）。非全局正则避免 lastIndex 漂移。 */
function normalizePrintf(p: string): string {
  const m = /%\d+\$([dsf])/.exec(p);
  return m ? `%${m[1]}` : p;
}

function collectList(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[0]);
}

/** 两组列表的多重集差(匿名占位符用 Counter 计数比较, 不做位置敏感——中文语序调整合法)。 */
function countDiff(
  enItems: string[],
  zhItems: string[],
  formatFn?: (p: string) => string,
): { missing: string[]; extra: string[] } {
  const enSorted = [...enItems].sort();
  const zhSorted = [...zhItems].sort();
  if (JSON.stringify(enSorted) === JSON.stringify(zhSorted)) return { missing: [], extra: [] };
  const fmt = (p: string) => (formatFn ? formatFn(p) : p);
  const enCount = new Map<string, number>();
  const zhCount = new Map<string, number>();
  for (const p of enSorted) enCount.set(p, (enCount.get(p) ?? 0) + 1);
  for (const p of zhSorted) zhCount.set(p, (zhCount.get(p) ?? 0) + 1);
  const missing = [...enCount.entries()].filter(([p, c]) => c > (zhCount.get(p) ?? 0)).map(([p]) => fmt(p));
  const extra = [...zhCount.entries()].filter(([p, c]) => c > (enCount.get(p) ?? 0)).map(([p]) => fmt(p));
  return { missing, extra };
}

/** 比较两组占位符列表，返回差异描述（缺失/多余）。 */
function compareLists(
  enItems: string[],
  zhItems: string[],
  label: string,
  formatFn?: (p: string) => string,
): string[] {
  const { missing, extra } = countDiff(enItems, zhItems, formatFn);
  const issues: string[] = [];
  if (missing.length > 0) issues.push(`缺失${label}: ${missing.join(", ")}`);
  if (extra.length > 0) issues.push(`多余${label}: ${extra.join(", ")}`);
  return issues;
}

function isTellrawJson(text: string): boolean {
  return RE_TELLRAW.test(text.trim());
}

function isChineseText(text: string): boolean {
  return RE_CHINESE_CHAR.test(text);
}

/** tellraw 递归比较非 text 键（仅 text 值可翻译）。 */
function compareTellraw(enObj: unknown, zhObj: unknown, path = ""): string[] {
  const diffs: string[] = [];
  if (typeof enObj === "object" && enObj !== null && typeof zhObj === "object" && zhObj !== null) {
    const enMap = enObj as Record<string, unknown>;
    const zhMap = zhObj as Record<string, unknown>;
    for (const k of Object.keys(enMap)) {
      if (k === "text") continue;
      if (!(k in zhMap)) {
        diffs.push(`缺少键: ${path}.${k}`);
      } else if (enMap[k] !== zhMap[k]) {
        diffs.push(`非text键被修改: ${path}.${k}`);
        diffs.push(...compareTellraw(enMap[k], zhMap[k], `${path}.${k}`));
      }
    }
    for (const k of Object.keys(zhMap)) {
      if (k === "text") continue;
      if (!(k in enMap)) diffs.push(`多余键: ${path}.${k}`);
    }
  }
  return diffs;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────

/**
 * 对单条对齐条目执行确定性格式检查（纯函数，零 LLM）。
 * 返回全部命中（一条目可命中多项）。
 */
export function checkEntryFormat(key: string, en: string, zh: string): FormatCheckFinding[] {
  const findings: FormatCheckFinding[] = [];

  // 1. 占位符数量比较（printf/%msg%/{0} 三类，位置占位符归一化）
  const enPrintf = [
    ...collectList(en, RE_PRINTF).map(normalizePrintf),
    ...collectList(en, RE_POSITIONAL_PRINTF).map(normalizePrintf),
  ];
  const zhPrintf = [
    ...collectList(zh, RE_PRINTF).map(normalizePrintf),
    ...collectList(zh, RE_POSITIONAL_PRINTF).map(normalizePrintf),
  ];
  const pIssues = [
    ...compareLists(enPrintf, zhPrintf, "占位符"),
    ...compareLists(collectList(en, RE_PERCENT_VAR), collectList(zh, RE_PERCENT_VAR), "变量"),
    ...compareLists(
      collectList(en, RE_BRACE_VAR),
      collectList(zh, RE_BRACE_VAR),
      "变量",
      (p) => `{${p}}`,
    ),
  ];
  if (pIssues.length > 0) {
    const pMissing = [
      ...countDiff(enPrintf, zhPrintf).missing,
      ...countDiff(collectList(en, RE_PERCENT_VAR), collectList(zh, RE_PERCENT_VAR)).missing,
      ...countDiff(collectList(en, RE_BRACE_VAR), collectList(zh, RE_BRACE_VAR), (p) => `{${p}}`).missing,
    ];
    const pExtra = [
      ...countDiff(enPrintf, zhPrintf).extra,
      ...countDiff(collectList(en, RE_PERCENT_VAR), collectList(zh, RE_PERCENT_VAR)).extra,
      ...countDiff(collectList(en, RE_BRACE_VAR), collectList(zh, RE_BRACE_VAR), (p) => `{${p}}`).extra,
    ];
    findings.push({
      issueType: "placeholder_count_mismatch",
      severity: "error",
      detail: `占位符不一致: ${pIssues.join("; ")}`,
      missing: pMissing,
      extra: pExtra,
    });
  }

  // 2. 特殊标签数量比较（§/& 色码、$(action)、HTML、<br>、换行）
  const tagChecks: Array<[RegExp, string]> = [
    [RE_MC_COLOR, "§颜色码"],
    [RE_ALT_COLOR, "&颜色码"],
    [RE_PLACEHOLDER_DOLLAR, "$(action)占位符"],
    [RE_HTML_TAG, "HTML标签"],
    [RE_BR_TAG, "<br>"],
    [RE_NEWLINE, "换行符"],
  ];
  const tIssues: string[] = [];
  const tMissing: string[] = [];
  const tExtra: string[] = [];
  for (const [re, label] of tagChecks) {
    const enFound = collectList(en, re).sort();
    const zhFound = collectList(zh, re).sort();
    const d = countDiff(enFound, zhFound);
    tMissing.push(...d.missing);
    tExtra.push(...d.extra);
    if (JSON.stringify(enFound) !== JSON.stringify(zhFound)) {
      tIssues.push(`${label}数量不一致: EN=${enFound.length}, ZH=${zhFound.length}`);
    }
  }
  if (tIssues.length > 0) {
    findings.push({
      issueType: "special_tag_mismatch",
      severity: "error",
      detail: `格式标签不一致: ${tIssues.join("; ")}`,
      missing: tMissing,
      extra: tExtra,
    });
  }

  // 3. tellraw JSON：仅翻译 text 键
  if (isTellrawJson(en)) {
    if (!isTellrawJson(zh)) {
      findings.push({ issueType: "tellraw_mismatch", severity: "error", detail: "EN 为 tellraw JSON 但 ZH 格式已破坏" });
    } else {
      try {
        const diffs = compareTellraw(JSON.parse(en), JSON.parse(zh));
        if (diffs.length > 0) {
          findings.push({ issueType: "tellraw_mismatch", severity: "error", detail: `tellraw JSON 非text键被修改: ${diffs.slice(0, 3).join("; ")}` });
        }
      } catch {
        // 无法解析，跳过
      }
    }
  }

  // 4. 唱片名不应翻译
  if (key.includes("music_disc") && key.endsWith(".desc") && en !== zh && en !== "" && zh !== "") {
    findings.push({ issueType: "music_disc_translated", severity: "warning", detail: `唱片名不应翻译，建议保留原文（${en}）` });
  }

  // 5. 标点规范（中文内容才检查；中英文间距白名单 book./patchouli.）
  if (isChineseText(zh)) {
    const punctIssues: string[] = [];
    const punctChecks: Array<[RegExp, string, string]> = [
      [/[\u4e00-\u9fff]\s*\.\s*[\u4e00-\u9fff]/, ".", "。"],
      [/[\u4e00-\u9fff]\s*,\s*[\u4e00-\u9fff]/, ",", "，"],
      [/[\u4e00-\u9fff]\s*\?\s*[\u4e00-\u9fff]/, "?", "？"],
      [/[\u4e00-\u9fff]\s*!\s*[\u4e00-\u9fff]/, "!", "！"],
      [/[\u4e00-\u9fff]\s*;\s*[\u4e00-\u9fff]/, ";", "；"],
      [/[\u4e00-\u9fff]\s*\(|\)\s*[\u4e00-\u9fff]/, "()", "（）"],
    ];
    for (const [re, half, full] of punctChecks) {
      if (re.test(zh)) punctIssues.push(`中文环境中使用了${half}，应使用'${full}'`);
    }
    const punctSpace = zh.match(/[\u4e00-\u9fff]\s+[，。；：？！、]|[，。；：？！、]\s+[\u4e00-\u9fff]/g);
    if (punctSpace) punctIssues.push(`中文与中文标点间有不必要空格（${punctSpace.length}处）`);
    const whitelisted = PUNCTUATION_SPACING_WHITELIST.some((p) => key.startsWith(p));
    if (!whitelisted) {
      const enCnSpaces = zh.match(/[\u4e00-\u9fff]\s+[A-Za-z0-9]|[A-Za-z0-9]\s+[\u4e00-\u9fff]/g);
      if (enCnSpaces) punctIssues.push(`中英文间有不必要空格（${enCnSpaces.length}处）`);
    }
    if (zh !== zh.trimEnd() && punctIssues.length === 0) {
      punctIssues.push("中文译文尾部有多余空格");
    }
    if (punctIssues.length > 0) {
      findings.push({ issueType: "punctuation_issue", severity: "warning", detail: `标点规范: ${punctIssues.join("; ")}` });
    }
  }

  // 6. 能量/体积单位保留原文
  const enUnits = collectList(en, RE_ENERGY_UNIT).sort();
  const zhUnits = collectList(zh, RE_ENERGY_UNIT).sort();
  if (enUnits.length > 0 && JSON.stringify(enUnits) !== JSON.stringify(zhUnits)) {
    const missing = enUnits.filter((u) => !zhUnits.includes(u));
    const extra = zhUnits.filter((u) => !enUnits.includes(u));
    findings.push({
      issueType: "energy_unit_translated",
      severity: "error",
      detail: `能量/体积单位不应翻译，缺少: ${missing.join(", ")}`,
      missing,
      extra,
    });
  }

  // 7. 省略号：不应使用三个英文句号
  if (RE_ELLIPSIS_WRONG.test(zh)) {
    findings.push({ issueType: "ellipsis_issue", severity: "warning", detail: "使用了三个英文句号'...'作为省略号，应使用'……'（中文省略号）" });
  }

  // 8. 声音字幕格式：主体：声音（全角冒号）
  if ((key.startsWith("subtitles.") || key.startsWith("sound.")) && !zh.includes("：") && !zh.includes(":")) {
    const enWords = en.split(/\s+/).filter((w) => w.length > 0);
    if (enWords.length >= 2 && en.length < 80) {
      findings.push({ issueType: "subtitle_format_issue", severity: "warning", detail: "声音字幕建议使用'主体：声音'格式（全角冒号）" });
    }
  }

  return findings;
}
