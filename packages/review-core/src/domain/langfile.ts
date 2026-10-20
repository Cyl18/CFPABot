import { applyEdits, getNodeValue, parseTree, printParseErrorCode, type Edit, type Node as JsonNode, type ParseError } from "jsonc-parser";
import type { LangFormat } from "./path.ts";

export interface ParsedLang {
  format: LangFormat;
  entries: Map<string, string>;
  lines: Map<string, number>;
  errors: string[];
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export function jsonErrorMessage(text: string, error: ParseError): string {
  return `第 ${text.slice(0, error.offset).split("\n").length} 行：${printParseErrorCode(error.error)}`;
}

function jsonRawValue(value: unknown): string {
  if (typeof value === "string") return value;
  const raw = JSON.stringify(value);
  return raw === undefined ? "" : raw;
}

function parseJsonLang(content: string): ParsedLang {
  const text = content.replace(/^\uFEFF/, "");
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  const starts = lineStarts(text);
  const entries = new Map<string, string>();
  const lines = new Map<string, number>();
  const first = errors[0];
  const messages = first === undefined ? [] : [jsonErrorMessage(text, first)];
  if (root === undefined) {
    if (messages.length === 0) messages.push("内容为空");
    return { format: "json", entries, lines, errors: messages };
  }
  if (root.type !== "object") {
    if (messages.length === 0) messages.push("顶层不是 JSON 对象");
    return { format: "json", entries, lines, errors: messages };
  }
  const failed = messages.length > 0;
  for (const property of root.children ?? []) {
    const keyNode = property.children?.[0];
    const valueNode = property.children?.[1];
    if (keyNode === undefined || valueNode === undefined || typeof keyNode.value !== "string") continue;
    lines.set(keyNode.value, lineOf(starts, keyNode.offset));
    if (!failed) entries.set(keyNode.value, jsonRawValue(getNodeValue(valueNode)));
  }
  return { format: "json", entries, lines, errors: messages };
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

export function editJsonValues(
  content: string,
  edit: (key: string, value: string) => string | undefined,
): { content: string; changed: number } {
  const root = parseTree(content, [], { allowTrailingComma: true });
  if (root === undefined || root.type !== "object") return { content, changed: 0 };
  const edits: Edit[] = [];
  const visit = (node: JsonNode): void => {
    if (node.type === "object") {
      for (const property of node.children ?? []) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        if (keyNode === undefined || valueNode === undefined || typeof keyNode.value !== "string") continue;
        if (valueNode.type === "string") {
          const next = edit(keyNode.value, String(valueNode.value));
          if (next !== undefined && next !== valueNode.value) {
            edits.push({ offset: valueNode.offset, length: valueNode.length, content: JSON.stringify(next) });
          }
          continue;
        }
        visit(valueNode);
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  if (edits.length === 0) return { content, changed: 0 };
  return { content: applyEdits(content, edits), changed: edits.length };
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

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export function detectIndent(content: string): string {
  const quote = /^([ \t]+)"/m.exec(content);
  if (quote) return quote[1] as string;
  const indented = /^([ \t]+)\S/m.exec(content);
  return indented ? (indented[1] as string) : "  ";
}
