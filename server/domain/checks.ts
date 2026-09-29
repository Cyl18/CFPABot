import type { CheckItem, PrFile, Severity } from "../../shared/api.ts";
import type { ParsedLang } from "./langfile.ts";
import { compareMc } from "./path.ts";

const LANG_FILE_RE = /^(zh_cn|en_us)\.(json|lang)$/i;
const ILLEGAL_PATH_RE = /[^0-9A-Za-z_\-./]/;

function badPathMessage(path: string): string | null {
  const names = path.split("/");
  const generic = `⚠ 检测到一个语言文件，但提交路径不正常。请检查提交路径：\`${path}\``;
  if (names.length === 1) return generic;
  if (names.length < 5 && (path.includes(".lang") || path.includes(".json"))) return generic;
  if (names[0] !== "projects") return generic;
  if (names.length === 5) {
    if (names[1] !== "assets" || names[2] === "lang") return generic;
    return `⚠ 检测到一个语言文件，但是提交路径不正常。缺少了 {ModDomain} 和 lang 文件夹。请检查你的提交路径：\`${path}\``;
  }
  if (names.length === 6) {
    if (names[4] === "lang") {
      return `⚠ 检测到一个语言文件，但提交路径不正常。缺少了 {ModDomain} 或 {CurseForge 项目名} 文件夹。请检查提交路径：\`${path}\``;
    }
    return `⚠ 检测到一个语言文件，但提交路径不正常。缺少了 lang 文件夹。请检查提交路径：\`${path}\``;
  }
  return null;
}

export function pathChecks(files: PrFile[]): CheckItem[] {
  const items: CheckItem[] = [];

  const patchouli = files.find((f) => f.path.split("/").includes("patchouli_book"));
  if (patchouli) {
    items.push({
      level: "warn",
      code: "patchouli_book",
      path: patchouli.path,
      message: "⚠ 检测到了一个名为 patchouli_book 的文件夹。你可能想说的是 patchouli_books？",
    });
  }

  const illegal = files.find((f) => f.path.includes("lang") && ILLEGAL_PATH_RE.test(f.path));
  if (illegal) {
    items.push({
      level: "warn",
      code: "illegal_path",
      path: illegal.path,
      message: `⚠⚠⚠ **检测到了可能不合规的路径。**\n⚠⚠⚠ 例如： \`${illegal.path}\``,
    });
  }

  let badCount = 0;
  for (const file of files) {
    if (badCount >= 5) break;
    if (!file.path.includes("zh_cn")) continue;
    if (file.path.split("/").length >= 7) continue;
    const message = badPathMessage(file.path);
    if (!message) continue;
    items.push({ level: "warn", code: "bad_path", path: file.path, message });
    badCount++;
  }

  const uppercase = files.find((f) => {
    const names = f.path.split("/");
    return (
      names.length >= 7 &&
      names[0] === "projects" &&
      names[5] === "lang" &&
      names.slice(0, -1).some((seg) => seg !== "1UNKNOWN" && seg.toLowerCase() !== seg)
    );
  });
  if (uppercase) {
    items.push({
      level: "warn",
      code: "uppercase_path",
      path: uppercase.path,
      message: `⚠ 警告：文件路径中含有大写字母。如 \`${uppercase.path}\``,
    });
  }

  for (const file of files) {
    if (file.status !== "removed") continue;
    if (!LANG_FILE_RE.test(file.path.split("/").pop() ?? "")) continue;
    items.push({
      level: "warn",
      code: "deleted_lang",
      path: file.path,
      message: `⚠ 删除了语言文件：\`${file.path}\``,
    });
  }

  for (const file of files) {
    if (!LANG_FILE_RE.test(file.path.split("/").pop() ?? "")) continue;
    if (file.path.startsWith("projects/")) continue;
    items.push({
      level: "warn",
      code: "stray_lang",
      path: file.path,
      message: `⚠ 语言文件不在 projects/ 目录下：\`${file.path}\``,
    });
  }

  return items;
}

export function keyParity(label: string, en: ParsedLang | null, zh: ParsedLang | null): CheckItem[] {
  const items: CheckItem[] = [];
  const syntaxErrors = [en, zh].filter((parsed) => parsed !== null && parsed.format === "json" && parsed.errors.length > 0);
  for (const parsed of syntaxErrors) {
    items.push({
      level: "error",
      code: "json_syntax",
      message: `❌ ${label} 的语言文件中有 JSON 语法错误：${parsed?.errors[0] ?? ""}`,
    });
  }
  if (items.length > 0) return items;

  const enEntries = en?.entries ?? new Map<string, string>();
  const zhEntries = zh?.entries ?? new Map<string, string>();
  if (enEntries.size === 0) {
    items.push({ level: "info", code: "key_parity", message: `ℹ ${label} 英文文件为空。` });
  }
  if (zhEntries.size === 0) {
    items.push({ level: "info", code: "key_parity", message: `ℹ ${label} 中文文件为空。` });
  }
  if (enEntries.size === 0 || zhEntries.size === 0) return items;

  const enKeys = [...enEntries.keys()].filter((key) => !key.startsWith("_"));
  const zhKeyList = [...zhEntries.keys()].filter((key) => !key.startsWith("_"));
  const zhKeys = new Set(zhKeyList);
  const enKeySet = new Set(enKeys);
  const enExcept = enKeys.filter((key) => !zhKeys.has(key));
  const zhExcept = zhKeyList.filter((key) => !enKeySet.has(key));

  if (enExcept.length === 0 && zhExcept.length === 0) {
    items.push({ level: "ok", code: "key_parity", message: `ℹ ${label} 中英文 Key 相互对应。` });
    return items;
  }

  const lines: string[] = [
    `⚠ PR 中 ${label} 中英文 Key 不对应。`,
    "<details><summary>详细报告</summary>",
    "",
  ];
  if (enExcept.length > 0) {
    lines.push(`- 英文有 ${enExcept.length} 个 Key 多于中文。例如：`);
    for (const key of enExcept.slice(0, 3)) {
      lines.push(`  - 行 ${en?.lines.get(key) ?? 0}-\`${key}\``);
    }
  }
  if (zhExcept.length > 0) {
    lines.push(`- 中文有 ${zhExcept.length} 个 Key 多于英文。例如：`);
    for (const key of zhExcept.slice(0, 3)) {
      lines.push(`  - 行 ${zh?.lines.get(key) ?? 0}-\`${key}\``);
    }
  }
  lines.push("", "</details>");
  items.push({ level: "warn", code: "key_parity", message: lines.join("\n") });
  return items;
}

export interface TypoRule {
  term: string;
  message: string;
  level: "warn" | "error";
  minVersion?: string;
  skipLegacy?: boolean;
  unless?: string[];
}

function shortenLine(line: string, checkname: string, version: string): string {
  const separator = version === "1.12.2" ? "=" : ":";
  const at = line.indexOf(separator);
  if (at < 0) return line;
  const value = line.slice(at + 1);
  if (value.length <= 28) return line;
  const pos = value.indexOf(checkname);
  if (pos < 0) return line;
  const start = Math.max(0, pos - 12);
  const end = Math.min(value.length, pos + checkname.length + 12);
  const body = `${start > 0 ? "..." : ""}${value.slice(start, end)}${end < value.length ? "..." : ""}`;
  return `${line.slice(0, at + 1)}${body}`;
}

export function typoCheck(
  lines: { path: string; line: number; text: string; version: string }[],
  rules: TypoRule[],
): CheckItem[] {
  const items: CheckItem[] = [];
  const reported = new Set<string>();
  for (const entry of lines) {
    for (const rule of rules) {
      if (reported.has(rule.term)) continue;
      if (!entry.text.includes(rule.term)) continue;
      if (rule.unless?.some((token) => entry.text.includes(token))) continue;
      if (rule.minVersion !== undefined && compareMc(entry.version, rule.minVersion) < 0) continue;
      if (rule.skipLegacy && entry.version === "1.12.2") continue;
      reported.add(rule.term);
      const example = shortenLine(entry.text, rule.term, entry.version);
      const prefix = rule.level === "error" ? "❌ 可能错误译名" : "ℹ 可能争议译名";
      items.push({
        level: rule.level,
        code: "typo",
        path: entry.path,
        message: `${prefix}：\`${rule.term}\`，${rule.message}。例如 \`${example}\`。`,
      });
    }
  }
  return items;
}

export interface Finding {
  code: string;
  hint: Severity;
  detail: string;
}

const CODE_RE = /[§&][0-9a-fk-or]/gi;
const EN_KEEP_PATTERNS = [/shader\.name\./, /painting\..*\.(author|title)$/, /\.my_man_diorite$/];
const KEPT_UNIT_RE = /mB|kHz|\bIF\b|Flux|flux|\bticks?\b/;
const ENERGY_RE = /\b(FE|RF|MB|Forge Energy)\b/;
const ENERGY_OK_RE = /\b(FE|RF|MB)\b/;
const CJK_RE = /[\u4e00-\u9fff]/;

function stripCodes(s: string): string {
  return s.replace(/§./g, "").replace(/<br\s*\/?>/gi, "").replace(/\\n/g, "");
}

function isFormatOnly(s: string): boolean {
  if (!/[a-zA-Z]/.test(s)) return true;
  const rest = stripCodes(s)
    .replace(/%\d?\$?[sd]/g, "")
    .replace(/[%§&<>{}$\d\s.,:;!?'"()[\]-]/g, "");
  return rest === "" || /^(m|mB|kHz|IF|Flux|flux|ticks?)$/.test(rest);
}

function fmtRefs(s: string): Map<number, string> {
  const refs = new Map<number, string>();
  let ord = 0;
  for (const m of s.matchAll(/%(?:(\d+)\$)?([sd])/g)) {
    const pos = m[1] ? Number(m[1]) : ++ord;
    refs.set(pos, m[2] as string);
  }
  return refs;
}

function checkPlaceholders(
  en: string,
  zh: string,
): { level: "pass" | "neutral" | "major" | "critical"; msg: string } {
  const a = fmtRefs(en);
  const b = fmtRefs(zh);
  const needA = a.size ? Math.max(...a.keys()) : 0;
  const needB = b.size ? Math.max(...b.keys()) : 0;
  const tmpl = (s: string): string =>
    [...s.replace(/%(?:\d+\$)?[sd]/g, "").matchAll(/%[A-Za-z_%]+%/g)].map((m) => m[0]).sort().join(",");
  const tA = tmpl(en);
  const tB = tmpl(zh);
  if (tA !== tB) return { level: "major", msg: `模板占位不一致 en[${tA}] zh[${tB}]` };
  for (const [pos, type] of b) {
    if (pos > needA) return { level: "critical", msg: `zh 需 ${needB} 参 > en 供 ${needA} 参，必崩` };
    const enType = a.get(pos);
    if (enType !== undefined && enType !== type) {
      return { level: "major", msg: `占位类型变 %${pos}$${enType}→${type}，需核调用点` };
    }
  }
  if (needB === needA && b.size === a.size) {
    let same = true;
    for (const [pos, type] of b) {
      if (a.get(pos) !== type) same = false;
    }
    if (same && [...a.keys()].every((pos) => b.has(pos))) return { level: "pass", msg: "" };
  }
  return { level: "neutral", msg: `zh 少占位（en 需 ${needA} 参 / zh 用 ${needB} 参，多余实参被忽略，安全）` };
}

function checkCodes(en: string, zh: string): string | null {
  const a = [...en.matchAll(CODE_RE)].map((m) => m[0].toLowerCase()).sort().join(",");
  const b = [...zh.matchAll(CODE_RE)].map((m) => m[0].toLowerCase()).sort().join(",");
  return a === b ? null : `en[${a}] zh[${b}]`;
}

function halfPunctHits(zh: string): string[] {
  const s = stripCodes(zh);
  const hits: string[] = [];
  const latin = /[A-Za-z0-9]/;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (!/[,\.!?;:'"]/.test(ch)) continue;
    const prev = s[i - 1] ?? "";
    const next = s[i + 1] ?? "";
    if (ch === "." && /\d/.test(prev) && /\d/.test(next)) continue;
    if (ch === "," && /[%sd\d]$/.test(s.slice(Math.max(0, i - 4), i)) && /^[%\d\s]/.test(next)) continue;
    if (
      /[!?;.:]/.test(ch) &&
      ((latin.test(prev) && CJK_RE.test(next)) || (CJK_RE.test(prev) && latin.test(next)))
    ) {
      continue;
    }
    if (CJK_RE.test(prev) || CJK_RE.test(next)) hits.push(`${prev}${ch}${next}`);
  }
  return hits;
}

export function entryFindings(
  key: string,
  en: string | undefined,
  zh: string | undefined,
  base?: { en?: string; zh?: string },
): Finding[] {
  const findings: Finding[] = [];
  if (zh === undefined) return findings;
  const e = en ?? "";
  const z = zh;

  if (z === "") {
    findings.push({ code: "empty_value", hint: "minor", detail: "空翻译值" });
  } else if (z === e && /[a-zA-Z]/.test(e)) {
    if (!isFormatOnly(e)) {
      if (KEPT_UNIT_RE.test(e)) {
        findings.push({
          code: "units_kept",
          hint: "neutral",
          detail: "单位/格式串保留英文（mB/kHz/IF/tick 类），通常有意为之",
        });
      } else {
        const kept = EN_KEEP_PATTERNS.some((re) => re.test(key));
        findings.push({
          code: "untranslated_value",
          hint: kept ? "neutral" : "minor",
          detail: kept
            ? "命中刻意保留模式（皮肤/画作/专有裸键），大概率 neutral"
            : "与英文完全相同，需判断是刻意保留还是漏译",
        });
      }
    }
  } else {
    const ph = checkPlaceholders(e, z);
    if (ph.level !== "pass") {
      findings.push({ code: "placeholder_mismatch", hint: ph.level, detail: ph.msg });
    }
    const codes = checkCodes(e, z);
    if (codes !== null) {
      findings.push({ code: "format_code_mismatch", hint: "major", detail: codes });
    }
    const punct = halfPunctHits(z);
    if (punct.length > 0) {
      findings.push({
        code: "half_punct",
        hint: "minor",
        detail: `半角标点：${[...new Set(punct)].join(" ")}`,
      });
    }
    const edge = (s: string): string => `${s.match(/^\s*/)?.[0] ?? ""}|${s.match(/\s*$/)?.[0] ?? ""}`;
    if (/ {2}/.test(z) && !/ {2}/.test(e)) {
      findings.push({ code: "double_space", hint: "minor", detail: "连续双空格" });
    }
    if (z !== z.trim() && edge(z) !== edge(e)) {
      findings.push({ code: "edge_space", hint: "minor", detail: `首尾空格：${JSON.stringify(z)}` });
    }
    if (/\bticks?\b/i.test(e) && !/刻/.test(z)) {
      findings.push({
        code: "tick_untranslated",
        hint: "minor",
        detail: /\bticks?\b/i.test(z)
          ? "tick 残留英文（全文 Tick 应统一为刻）"
          : "tick 未体现（译刻/保留/意译三选一，需全文件统一）",
      });
    }
    if (ENERGY_RE.test(e) && !(ENERGY_OK_RE.test(z) || /锻造能量/.test(z))) {
      findings.push({
        code: "energy_unit_translated",
        hint: "major",
        detail: "能量/体积单位疑似被翻译或丢失（FE/RF/MB 应保留）",
      });
    }
    if (/subtitle|subtitles|sound/.test(key) && !/[：:]/.test(z) && e.trim().split(/\s+/).length >= 2) {
      findings.push({
        code: "subtitle_no_colon",
        hint: "neutral",
        detail: "字幕无冒号（主谓结构建议 主体：声音；无主语可豁免）",
      });
    }
    if (/\b(shift|ctrl)\b/.test(z)) {
      findings.push({
        code: "modifier_key_case",
        hint: "minor",
        detail: "功能键应首字母大写（Shift/Ctrl）且不翻译",
      });
    }
  }

  if (base && base.en !== undefined && base.zh !== undefined && en !== undefined) {
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
    if (base.en !== e && base.zh === z && norm(base.en) !== norm(e)) {
      findings.push({
        code: "stale_translation",
        hint: "major",
        detail: `原文已变（${JSON.stringify(base.en)} → ${JSON.stringify(e)}）而译文未动`,
      });
    }
  }

  return findings;
}

export function fileFindings(content: string): Finding[] {
  const findings: Finding[] = [];
  if (!content.endsWith("\n")) {
    findings.push({ code: "no_trailing_newline", hint: "neutral", detail: "文件末无换行" });
  }
  if (/^\t/m.test(content) && /^ {2}/m.test(content)) {
    findings.push({ code: "mixed_indent", hint: "neutral", detail: "tab 与空格缩进混用" });
  }
  return findings;
}

export function duplicateZh(rows: { key: string; en?: string; zh?: string }[]): Map<string, string[]> {
  const groups = new Map<string, { keys: string[]; ens: Set<string> }>();
  for (const row of rows) {
    const zh = row.zh;
    if (zh === undefined || zh === "") continue;
    if (!CJK_RE.test(zh)) continue;
    const group = groups.get(zh) ?? { keys: [], ens: new Set<string>() };
    group.keys.push(row.key);
    if (row.en !== undefined) group.ens.add(row.en);
    groups.set(zh, group);
  }
  const out = new Map<string, string[]>();
  for (const [zh, group] of groups) {
    if (group.keys.length <= 1) continue;
    if (group.ens.size <= 1) continue;
    out.set(zh, group.keys);
  }
  return out;
}
