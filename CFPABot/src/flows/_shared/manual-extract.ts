// src/flows/_shared/manual-extract.ts
// Pure manual-review extraction primitives (手册对齐 DSL v2). No I/O.
//
// Each entry: key(对齐键) + value(可选的条目内容) + span(1-based 行号区间,
// 仅行定位类 mode 提供; kv-json 无法可靠定位, 不提供 span)。
//
// mode 白名单(硬约束, 白名单外抛错, 禁止任意代码):
//   markdown-heading — `## 标题` 起 section, 到下一个标题行结束; key=标题文本
//   line-table       — 每非空行一个条目; key=1-based 行号(字符串), value=整行
//   kv-json          — JSON 扁平化; key=json-path(a.b.c / a[0].b), value=叶子值
//   regex            — 逐 match; key=捕获组 1, value=完整匹配文本; 需 extract.regex
//                     (支持 /pattern/flags 字面量写法, 如 /^##\s+(.+)$/gm)
//
// glob 匹配(简单实现): `**` = 零或多个路径段(跨 /), `*` = 段内任意字符,
// 其余字符字面匹配; 大小写敏感, 全路径锚定。

// ─── Types ────────────────────────────────────────────────────────────

export const MANUAL_EXTRACT_MODES = [
  "markdown-heading",
  "line-table",
  "kv-json",
  "regex",
] as const;

export type ManualExtractMode = (typeof MANUAL_EXTRACT_MODES)[number];

export const MANUAL_KEY_FROM = ["heading", "line", "json-path", "group"] as const;

export type ManualKeyFrom = (typeof MANUAL_KEY_FROM)[number];

export interface ManualRuleExtract {
  mode: ManualExtractMode;
  keyFrom?: ManualKeyFrom;
  /** regex mode 必填: 正则源码(捕获组 1 作为 key)。 */
  regex?: string;
}

export interface ManualRule {
  name: string;
  /** glob 模式, 匹配 zh 侧文件路径(如 projects/**&#47;guide.md)。 */
  match: string;
  extract: ManualRuleExtract;
}

export interface ManualExtractedEntry {
  key: string;
  value?: string;
  /** 1-based 行号区间(含端点)。 */
  span?: { start: number; end: number };
}

// ─── Glob matching ────────────────────────────────────────────────────

/**
 * Convert a simple glob to an anchored RegExp.
 * - `**` alone       → `.*`(任意字符, 含斜杠)
 * - `**` + `/` 前缀  → 可选零或多个路径段(匹配零段也成功)
 * - `*`              → `[^/]*`(段内任意字符, 不跨斜杠)
 * - 其余字符字面匹配(正则元字符转义)
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else {
      out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Full-path glob match (case-sensitive, anchored). */
export function globMatch(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

// ─── Mode-specific extractors ─────────────────────────────────────────

/**
 * markdown-heading: `## 标题` 到下一个 `##` 级标题之间的内容为一个条目。
 * 仅 `##` 级(后跟空格/行尾)行是 section 边界; `#`/`###`+ 以及首个 `##` 之前
 * 的内容都属于正文(不入条目)。空标题(如 `## `)只作边界、不开启新 section。
 * span = [标题行, 最后一个内容行](无内容时为标题行本身)。
 */
export function extractMarkdownHeadings(content: string): ManualExtractedEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: ManualExtractedEntry[] = [];
  let current: { key: string; start: number; content: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    // 去掉尾部空行(布局性空行不算内容, 避免 span 末尾多算)
    const bodyLines = current.content;
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === "") {
      bodyLines.pop();
    }
    const body = bodyLines.join("\n").trim();
    entries.push({
      key: current.key,
      value: body,
      span: { start: current.start, end: current.start + bodyLines.length },
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##(?:\s|$)/.test(line)) {
      const headingText = line.replace(/^##\s*/, "").trim();
      flush();
      if (headingText !== "") current = { key: headingText, start: i + 1, content: [] };
    } else if (current) {
      current.content.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * line-table: 每个非空行一个条目。key = 1-based 行号(字符串), value = 整行
 * (去掉尾部 \r)。空行不产出条目。
 */
export function extractLineTable(content: string): ManualExtractedEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: ManualExtractedEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    entries.push({ key: String(i + 1), value: line, span: { start: i + 1, end: i + 1 } });
  }
  return entries;
}

function flattenJson(value: unknown, prefix: string, out: ManualExtractedEntry[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      flattenJson(value[i], `${prefix}[${i}]`, out);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenJson(v, prefix === "" ? k : `${prefix}.${k}`, out);
    }
    return;
  }
  out.push({
    key: prefix,
    value: typeof value === "string" ? value : JSON.stringify(value),
  });
}

/**
 * kv-json: 解析 JSON 并扁平化。对象键用 `.` 连接, 数组用 `[i]` 下标
 * (json-path 语义: a.b.c / a[0].b)。叶子值为字符串时原样保留, 否则 JSON 化。
 * 根必须是对象或数组; 内容非法 JSON 时抛错(调用方按文件捕获)。
 */
export function extractKvJson(content: string): ManualExtractedEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`kv-json: 内容不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("kv-json: 根值必须是对象或数组");
  }
  const entries: ManualExtractedEntry[] = [];
  flattenJson(parsed, "", entries);
  return entries;
}

const REGEX_LITERAL_RE = /^\/(.*)\/([a-z]*)$/s;

/**
 * 编译规则正则: 支持 JS 字面量写法 `/pattern/flags`(如 `/^##\s+(.+)$/gm`),
 * 否则把整个字符串当 pattern 并追加 `g` 标志。非法时抛错。
 */
export function compileRegexSource(regexSource: string): RegExp {
  const literal = regexSource.trim().match(REGEX_LITERAL_RE);
  if (literal) {
    const userFlags = literal[2] ?? "";
    const flags = [...new Set(userFlags + "g")].join("");
    return new RegExp(literal[1]!, flags);
  }
  return new RegExp(regexSource, "g");
}

/**
 * regex: 用 extract.regex(compileRegexSource 编译) 逐 match 提取。
 * key = 捕获组 1; value = 完整匹配文本; span = 匹配跨过的行号区间。
 * 模式缺少捕获组 1 或模式非法时抛错; 无匹配返回空数组。
 */
export function extractRegexEntries(content: string, regexSource: string): ManualExtractedEntry[] {
  if (!regexSource || regexSource.trim() === "") {
    throw new Error("regex: 缺少 extract.regex(正则模式)");
  }
  let re: RegExp;
  try {
    re = compileRegexSource(regexSource);
  } catch (err) {
    throw new Error(`regex: extract.regex 非法: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries: ManualExtractedEntry[] = [];
  const lineOf = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    return line;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const key = m[1];
    if (key === undefined) {
      throw new Error(`regex: 模式 "${regexSource}" 需要至少一个捕获组(组 1 作为 key)`);
    }
    const start = m.index;
    const end = start + m[0].length;
    entries.push({
      key,
      value: m[0],
      span: { start: lineOf(start), end: lineOf(end) },
    });
    // 零宽匹配防死循环
    if (m[0].length === 0) re.lastIndex++;
  }
  return entries;
}

// ─── Dispatcher ───────────────────────────────────────────────────────

const MODE_KEY_FROM: Record<ManualExtractMode, ManualKeyFrom> = {
  "markdown-heading": "heading",
  "line-table": "line",
  "kv-json": "json-path",
  "regex": "group",
};

/**
 * 按 rule 提取条目。未知 mode 抛错(白名单: markdown-heading|line-table|
 * kv-json|regex)。filePath 仅用于错误信息。
 */
export function extractManualEntries(
  content: string,
  rule: ManualRule,
  filePath: string,
): ManualExtractedEntry[] {
  const mode = rule.extract.mode;
  const canonicalKeyFrom = MODE_KEY_FROM[mode as ManualExtractMode];
  if (canonicalKeyFrom === undefined) {
    throw new Error(
      `${filePath}: 不支持的提取 mode "${String(mode)}"(白名单: ${MANUAL_EXTRACT_MODES.join("|")})`,
    );
  }
  if (rule.extract.keyFrom !== undefined && rule.extract.keyFrom !== canonicalKeyFrom) {
    throw new Error(
      `${filePath}: rule "${rule.name}" mode ${mode} 要求 keyFrom=${canonicalKeyFrom}, 得到 ${rule.extract.keyFrom}`,
    );
  }
  switch (mode) {
    case "markdown-heading":
      return extractMarkdownHeadings(content);
    case "line-table":
      return extractLineTable(content);
    case "kv-json":
      return extractKvJson(content);
    case "regex":
      return extractRegexEntries(content, rule.extract.regex ?? "");
  }
}

// ─── Validation ───────────────────────────────────────────────────────

/**
 * 单条规则的静态校验: name/match 非空、mode 在白名单、keyFrom 与 mode 匹配、
 * regex mode 必须有可编译的 extract.regex。返回错误列表(空 = 合法)。
 */
export function validateManualRule(rule: ManualRule): string[] {
  const errors: string[] = [];
  const label = rule?.name ? `rule "${rule.name}"` : "rule";
  if (!rule || typeof rule !== "object") return [`${label}: 规则必须是对象`];
  if (typeof rule.name !== "string" || rule.name.trim() === "") {
    errors.push("rule.name 不能为空");
  }
  if (typeof rule.match !== "string" || rule.match.trim() === "") {
    errors.push(`${label}: match(glob) 不能为空`);
  } else {
    try {
      globToRegExp(rule.match);
    } catch (err) {
      errors.push(`${label}: match 不是合法 glob: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const extract = rule.extract;
  if (!extract || typeof extract !== "object") {
    errors.push(`${label}: 缺少 extract 映射`);
    return errors;
  }
  const mode = extract.mode as ManualExtractMode;
  if (typeof mode !== "string" || (MANUAL_EXTRACT_MODES as readonly string[]).indexOf(mode) === -1) {
    errors.push(`${label}: mode "${String(mode)}" 不在白名单(${MANUAL_EXTRACT_MODES.join("|")})`);
    return errors;
  }
  const canonical = MODE_KEY_FROM[mode];
  if (extract.keyFrom !== undefined && extract.keyFrom !== canonical) {
    errors.push(`${label}: mode ${mode} 要求 keyFrom=${canonical}, 得到 ${extract.keyFrom}`);
  }
  if (mode === "regex") {
    if (typeof extract.regex !== "string" || extract.regex.trim() === "") {
      errors.push(`${label}: regex mode 需要 extract.regex 字段`);
    } else {
      try {
        compileRegexSource(extract.regex);
      } catch (err) {
        errors.push(`${label}: extract.regex 非法: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return errors;
}

/** 列表级校验: 每条规则合法 + name 在列表内唯一。 */
export function validateManualRules(rules: ManualRule[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(rules)) return ["rules 必须是数组"];
  const seen = new Map<string, number>();
  for (const rule of rules) {
    errors.push(...validateManualRule(rule));
    const name = rule?.name;
    if (typeof name === "string" && name.trim() !== "") {
      const prev = seen.get(name) ?? 0;
      seen.set(name, prev + 1);
    }
  }
  for (const [name, count] of seen) {
    if (count > 1) errors.push(`规则名重复: "${name}"(${count} 次)`);
  }
  return errors;
}
