import type { Finding, PrFile, Severity } from "@cfpa/contracts/api";
import type { ParsedLang } from "./langfile.ts";
import { compareMc } from "./path.ts";
import { CJK_SPACE_RE, formatCodes, patchouliClosers, placeholders, tags } from "./lint.ts";

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

export function pathChecks(files: PrFile[]): Finding[] {
  const findings: Finding[] = [];
  const head = files.filter((file) => file.status !== "removed");

  const patchouli = head.find((f) => f.path.split("/").includes("patchouli_book"));
  if (patchouli) {
    findings.push({
      code: "patchouli_book",
      severity: "minor",
      source: "program",
      path: patchouli.path,
      detail: "检测到了一个名为 patchouli_book 的文件夹。你可能想说的是 patchouli_books？",
    });
  }

  const illegal = head.find((f) => f.path.includes("lang") && ILLEGAL_PATH_RE.test(f.path));
  if (illegal) {
    findings.push({
      code: "illegal_path",
      severity: "major",
      source: "program",
      path: illegal.path,
      detail: `检测到了可能不合规的路径。例如： \`${illegal.path}\``,
    });
  }

  let badCount = 0;
  for (const file of head) {
    if (badCount >= 5) break;
    if (!file.path.includes("zh_cn")) continue;
    if (file.path.split("/").length >= 7) continue;
    const message = badPathMessage(file.path);
    if (!message) continue;
    findings.push({ code: "bad_path", severity: "major", source: "program", path: file.path, detail: message });
    badCount++;
  }

  const uppercase = head.find((f) => {
    const names = f.path.split("/");
    return (
      names.length >= 7 &&
      names[0] === "projects" &&
      names[5] === "lang" &&
      names.slice(0, -1).some((seg) => seg !== "1UNKNOWN" && seg.toLowerCase() !== seg)
    );
  });
  if (uppercase) {
    findings.push({
      code: "uppercase_path",
      severity: "minor",
      source: "program",
      path: uppercase.path,
      detail: `文件路径中含有大写字母。如 \`${uppercase.path}\``,
    });
  }

  for (const file of files) {
    if (file.status !== "removed") continue;
    if (!LANG_FILE_RE.test(file.path.split("/").pop() ?? "")) continue;
    findings.push({
      code: "deleted_lang",
      severity: "major",
      source: "program",
      path: file.path,
      detail: `删除了语言文件：\`${file.path}\``,
    });
  }

  for (const file of head) {
    if (!LANG_FILE_RE.test(file.path.split("/").pop() ?? "")) continue;
    if (file.path.startsWith("projects/")) continue;
    findings.push({
      code: "stray_lang",
      severity: "major",
      source: "program",
      path: file.path,
      detail: `语言文件不在 projects/ 目录下：\`${file.path}\``,
    });
  }

  return findings;
}

export function keyParity(unit: string, en: ParsedLang | null, zh: ParsedLang | null): Finding[] {
  const findings: Finding[] = [];
  const syntaxErrors = [en, zh].filter((parsed) => parsed !== null && parsed.format === "json" && parsed.errors.length > 0);
  for (const parsed of syntaxErrors) {
    findings.push({
      code: "json_syntax",
      severity: "critical",
      source: "program",
      unit,
      detail: `语言文件中有 JSON 语法错误：${parsed?.errors[0] ?? ""}`,
    });
  }
  if (findings.length > 0) return findings;

  const enEntries = en?.entries ?? new Map<string, string>();
  const zhEntries = zh?.entries ?? new Map<string, string>();
  if (enEntries.size === 0) {
    findings.push({ code: "file_empty", severity: "major", source: "program", unit, detail: "英文文件为空" });
  }
  if (zhEntries.size === 0) {
    findings.push({ code: "file_empty", severity: "major", source: "program", unit, detail: "中文文件为空" });
  }
  if (enEntries.size === 0 || zhEntries.size === 0) return findings;

  const enKeys = [...enEntries.keys()].filter((key) => !key.startsWith("_"));
  const zhKeyList = [...zhEntries.keys()].filter((key) => !key.startsWith("_"));
  const zhKeys = new Set(zhKeyList);
  const enKeySet = new Set(enKeys);
  const enExcept = enKeys.filter((key) => !zhKeys.has(key));
  const zhExcept = zhKeyList.filter((key) => !enKeySet.has(key));

  if (enExcept.length > 0) {
    findings.push({
      code: "key_parity",
      severity: "major",
      source: "program",
      unit,
      keys: enExcept,
      detail: `英文有 ${enExcept.length} 个 Key 多于中文`,
    });
  }
  if (zhExcept.length > 0) {
    findings.push({
      code: "key_parity",
      severity: "major",
      source: "program",
      unit,
      keys: zhExcept,
      detail: `中文有 ${zhExcept.length} 个 Key 多于英文`,
    });
  }
  return findings;
}

export interface TypoRule {
  term: string;
  message: string;
  level: "warn" | "error";
  minVersion?: string;
  skipLegacy?: boolean;
  unless?: string[];
}

export function shortenLine(line: string, checkname: string, version: string): string {
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
): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const entry of lines) {
    for (const rule of rules) {
      const key = `${entry.path}\u0000${rule.term}`;
      if (reported.has(key)) continue;
      if (!entry.text.includes(rule.term)) continue;
      if (rule.unless?.some((token) => entry.text.includes(token))) continue;
      if (rule.minVersion !== undefined && compareMc(entry.version, rule.minVersion) < 0) continue;
      if (rule.skipLegacy && entry.version === "1.12.2") continue;
      reported.add(key);
      const example = shortenLine(entry.text, rule.term, entry.version);
      const prefix = rule.level === "error" ? "可能错误译名" : "可能争议译名";
      findings.push({
        code: "typo",
        severity: rule.level === "error" ? "major" : "minor",
        source: "program",
        path: entry.path,
        line: entry.line,
        detail: `${prefix}：\`${rule.term}\`，${rule.message}。例如 \`${example}\`。`,
      });
    }
  }
  return findings;
}

const EN_KEEP_PATTERNS = [/shader\.name\./, /painting\..*\.(author|title)$/, /\.my_man_diorite$/];
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
  const at = { source: "program" as const, key };

  if (z === "") {
    findings.push({ ...at, code: "empty_value", severity: "minor", detail: "空翻译值" });
  } else if (z === e && /[a-zA-Z]/.test(e)) {
    if (!isFormatOnly(e)) {
      const kept = EN_KEEP_PATTERNS.some((re) => re.test(key));
      findings.push({
        ...at,
        code: "untranslated_value",
        severity: kept ? "neutral" : "minor",
        detail: kept
          ? "命中刻意保留模式（皮肤/画作/专有裸键），大概率 neutral"
          : "与英文完全相同，需判断是刻意保留还是漏译",
      });
    }
  } else {
    const a = placeholders(e);
    const b = placeholders(z);
    if (a.join("|") !== b.join("|")) {
      findings.push({
        ...at,
        code: "placeholder_mismatch",
        severity: b.length > a.length ? "critical" : "major",
        detail: `占位符不一致 en[${a.join(",")}] zh[${b.join(",")}]`,
      });
    }
    const aCodes = formatCodes(e);
    const bCodes = formatCodes(z);
    if (aCodes.join("|") !== bCodes.join("|")) {
      findings.push({
        ...at,
        code: "format_code_mismatch",
        severity: "major",
        detail: `格式码不一致 en[${aCodes.join(",")}] zh[${bCodes.join(",")}]`,
      });
    }
    const aTags = tags(e);
    const bTags = tags(z);
    if (aTags.join("|") !== bTags.join("|")) {
      findings.push({
        ...at,
        code: "tag_mismatch",
        severity: "major",
        detail: `HTML 标签不一致 en[${aTags.join(",")}] zh[${bTags.join(",")}]`,
      });
    }
    // 译者可以给中文加 `$(hex)…/$` 这类配色，但少一个收尾 `$` 就是没闭合。
    const enClosers = patchouliClosers(e);
    const zhClosers = patchouliClosers(z);
    if (zhClosers < enClosers) {
      findings.push({
        ...at,
        code: "patchouli_mismatch",
        severity: "major",
        detail: `Patchouli 收尾 $ 少于英文 en[${enClosers}] zh[${zhClosers}]，可能有标记没闭合`,
      });
    }
    const enLines = e.split("\n").length - 1;
    const zhLines = z.split("\n").length - 1;
    if (enLines !== zhLines) {
      findings.push({
        ...at,
        code: "newline_mismatch",
        severity: "major",
        detail: `换行数量不一致 en[${enLines}] zh[${zhLines}]`,
      });
    }
    const enTabs = e.split("\t").length - 1;
    const zhTabs = z.split("\t").length - 1;
    if (enTabs !== zhTabs) {
      findings.push({
        ...at,
        code: "tab_mismatch",
        severity: "minor",
        detail: `制表符数量不一致 en[${enTabs}] zh[${zhTabs}]`,
      });
    }
    const punct = halfPunctHits(z);
    if (punct.length > 0) {
      findings.push({
        ...at,
        code: "half_punct",
        severity: "minor",
        detail: `半角标点：${[...new Set(punct)].join(" ")}`,
      });
    }
    if (/ {2}/.test(z) && !/ {2}/.test(e)) {
      findings.push({ ...at, code: "double_space", severity: "minor", detail: "连续双空格" });
    }
    const zEdge = `${z.match(/^\s*/)?.[0] ?? ""}|${z.match(/\s*$/)?.[0] ?? ""}`;
    const eEdge = `${e.match(/^\s*/)?.[0] ?? ""}|${e.match(/\s*$/)?.[0] ?? ""}`;
    if (z !== z.trim() && zEdge !== eEdge) {
      findings.push({ ...at, code: "edge_space", severity: "minor", detail: `首尾空格：${JSON.stringify(z)}` });
    }
    if (CJK_SPACE_RE.test(z)) {
      findings.push({ ...at, code: "cjk_space", severity: "minor", detail: "汉字之间有空格" });
    }
    if (/subtitle|subtitles|sound/.test(key) && !/[：:]/.test(z) && e.trim().split(/\s+/).length >= 2) {
      findings.push({
        ...at,
        code: "subtitle_no_colon",
        severity: "neutral",
        detail: "字幕无冒号（主谓结构建议 主体：声音；无主语可豁免）",
      });
    }
    if (/\b(shift|ctrl)\b/.test(z)) {
      findings.push({
        ...at,
        code: "modifier_key_case",
        severity: "minor",
        detail: "功能键应首字母大写（Shift/Ctrl）且不翻译",
      });
    }
  }

  if (base && base.en !== undefined && base.zh !== undefined && en !== undefined) {
    const baseEnNorm = base.en.toLowerCase().replace(/\s+/g, " ").trim();
    const eNorm = e.toLowerCase().replace(/\s+/g, " ").trim();
    if (base.en !== e && base.zh === z && baseEnNorm !== eNorm) {
      findings.push({
        ...at,
        code: "stale_translation",
        severity: "major",
        detail: `原文已变（${JSON.stringify(base.en)} → ${JSON.stringify(e)}）而译文未动`,
      });
    }
  }

  return findings;
}

export function fileFindings(path: string, content: string): Finding[] {
  const findings: Finding[] = [];
  if (!content.endsWith("\n")) {
    findings.push({
      code: "no_trailing_newline",
      severity: "neutral",
      source: "program",
      path,
      detail: "文件末无换行",
    });
  }
  if (/^\t/m.test(content) && /^ {2}/m.test(content)) {
    findings.push({
      code: "mixed_indent",
      severity: "neutral",
      source: "program",
      path,
      detail: "tab 与空格缩进混用",
    });
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
