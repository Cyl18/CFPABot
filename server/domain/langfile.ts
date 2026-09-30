import type { LangFormat } from "./path.ts";

export interface ParsedLang {
  format: LangFormat;
  entries: Map<string, string>;
  lines: Map<string, number>;
  errors: string[];
}

const KEY_LINE_RE = /^\s*"((?:[^"\\]|\\.)*)"\s*:/;

export function stripJsonComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (inString) {
      out.push(ch);
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out.push(next);
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      out.push("  ");
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < text.length) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

export function stripTrailingCommas(text: string): string {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (inString) {
      out.push(ch);
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out.push(next);
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

function jsonRawValue(value: unknown): string {
  if (typeof value === "string") return value;
  const raw = JSON.stringify(value);
  return raw === undefined ? "" : raw;
}

function parseJsonLang(content: string): ParsedLang {
  const body = stripTrailingCommas(stripJsonComments(content.replace(/^\uFEFF/, "")));
  const lines = new Map<string, number>();
  const bodyLines = body.split("\n");
  for (let i = 0; i < bodyLines.length; i++) {
    const m = KEY_LINE_RE.exec(bodyLines[i] as string);
    if (!m) continue;
    let key: string;
    try {
      key = JSON.parse(`"${m[1] as string}"`) as string;
    } catch {
      continue;
    }
    lines.set(key, i + 1);
  }

  const entries = new Map<string, string>();
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "JSON 解析失败");
    return { format: "json", entries, lines, errors };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push("顶层不是 JSON 对象");
    return { format: "json", entries, lines, errors };
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    entries.set(key, jsonRawValue(value));
  }
  return { format: "json", entries, lines, errors };
}

function parseDotLang(content: string): ParsedLang {
  const entries = new Map<string, string>();
  const lines = new Map<string, number>();
  const errors: string[] = [];
  const raw = content.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = (raw[i] as string).replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) {
      errors.push(`第 ${i + 1} 行缺少 "="`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key === "") {
      errors.push(`第 ${i + 1} 行 "=" 前没有 key`);
      continue;
    }
    entries.set(key, line.slice(eq + 1));
    lines.set(key, i + 1);
  }
  return { format: "lang", entries, lines, errors };
}

export function parseLang(content: string, format: LangFormat): ParsedLang {
  return format === "json" ? parseJsonLang(content) : parseDotLang(content);
}

export function guessFormat(content: string): LangFormat {
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("{")) return "json";
  }
  return "lang";
}

function formatLangRef(content: string): string {
  let out = "";
  let i = 0;
  let lineStart = true;
  let block = false;
  while (i < content.length) {
    const ch = content[i] as string;
    if (block) {
      if (lineStart && ch !== "\n") {
        out += "#";
        lineStart = false;
      }
      if (ch === "*" && content[i + 1] === "/") {
        i += 2;
        block = false;
        continue;
      }
      out += ch;
      if (ch === "\n") lineStart = true;
      i++;
      continue;
    }
    if (lineStart) {
      if (ch === "/" && content[i + 1] === "/") {
        out += "#";
        i += 2;
        while (i < content.length && content[i] !== "\n") {
          out += content[i];
          i++;
        }
        continue;
      }
      if (ch === "/" && content[i + 1] === "*") {
        i += 2;
        block = true;
        continue;
      }
      if (ch === "=") {
        while (i < content.length && content[i] !== "\n") i++;
        continue;
      }
      if (ch === "\n") {
        out += ch;
        i++;
        continue;
      }
      lineStart = false;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    if (ch === "\n") lineStart = true;
    i++;
  }
  return out;
}

export function normalizeLang(content: string, format: LangFormat): string {
  if (format === "lang") return formatLangRef(content);
  const parsed = parseLang(content, "json");
  const obj: Record<string, string> = {};
  for (const [key, value] of parsed.entries) obj[key] = value;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function sortLang(content: string, format: LangFormat): string {
  if (format === "json") {
    const parsed = parseLang(content, "json");
    const obj: Record<string, string> = {};
    for (const key of [...parsed.entries.keys()].sort()) obj[key] = parsed.entries.get(key) as string;
    return `${JSON.stringify(obj, null, detectIndent(content))}\n`;
  }
  const lines = content
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => {
      const t = line.trim();
      return t !== "" && !t.startsWith("#") && !t.startsWith("//");
    });
  lines.sort((a, b) => {
    const ka = a.split("=")[0] as string;
    const kb = b.split("=")[0] as string;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return `${lines.join("\n")}\n`;
}

const KV_LINE_RE = /^(\s*"((?:[^"\\]|\\.)*)"\s*:\s*)"((?:[^"\\]|\\.)*?)"([^\r\n]*)(\r?\n|$)/gm;

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export function editJsonValues(
  content: string,
  edit: (key: string, value: string) => string | undefined,
): { content: string; changed: number } {
  let changed = 0;
  const out = content.replace(KV_LINE_RE, (full, prefix: string, rawKey: string, rawValue: string, rest: string, eol: string) => {
    const next = edit(unescapeJsonString(rawKey), unescapeJsonString(rawValue));
    if (next === undefined) return full;
    changed++;
    return `${prefix}${JSON.stringify(next)}${rest}${eol}`;
  });
  return { content: out, changed };
}

export function insertJsonKeyAfter(
  content: string,
  afterKey: string,
  newKey: string,
  value: string,
): string | null {
  const parts = content.split(/(?<=\n)/);
  let index = -1;
  let indent = "";
  let hadComma = false;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] as string;
    const m = /^([ \t]*)"((?:[^"\\]|\\.)*)"\s*:/.exec(seg);
    if (!m) continue;
    if (unescapeJsonString(m[2] as string) !== afterKey) continue;
    index = i;
    indent = m[1] as string;
    hadComma = /,[ \t]*\r?\n?$/.test(seg);
    break;
  }
  if (index < 0) return null;

  const seg = parts[index] as string;
  const eolMatch = /(\r?\n)$/.exec(seg);
  const eol = eolMatch ? (eolMatch[1] as string) : content.includes("\r\n") ? "\r\n" : "\n";
  parts[index] = hadComma
    ? seg
    : eolMatch
      ? `${seg.slice(0, -eol.length)},${eol}`
      : `${seg},`;
  parts.splice(
    index + 1,
    0,
    `${indent}${JSON.stringify(newKey)}: ${JSON.stringify(value)}${hadComma ? "," : ""}${eol}`,
  );
  return parts.join("");
}

export function detectIndent(content: string): string {
  const quote = /^([ \t]+)"/m.exec(content);
  if (quote) return quote[1] as string;
  const indented = /^([ \t]+)\S/m.exec(content);
  return indented ? (indented[1] as string) : "  ";
}
