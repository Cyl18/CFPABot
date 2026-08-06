// src/flows/_shared/language/lang-file.ts
// PURE: Parse Minecraft language files (JSON and .lang formats).
// No I/O, no globals, no side effects.

import type { LangFileParseResult, LanguageFileFormat } from "../types.js";

// ──────────────────────────────────────────
// Parse
// ──────────────────────────────────────────

/**
 * Parse a Minecraft language file string into a key-value map.
 * Supports both JSON (.json) and .lang formats.
 *
 * JSON format:
 *   { "key": "value", ... }
 *
 * .lang format:
 *   # comment
 *   key=value
 */
export function parseLangFile(
  content: string,
  format: LanguageFileFormat,
): LangFileParseResult {
  if (format === "json") {
    return parseJsonLang(content);
  }
  return parseDotLang(content);
}

function parseJsonLang(content: string): LangFileParseResult {
  const errors: LangFileParseResult["errors"] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Invalid JSON";
    errors.push({ message });
    return { entries: {}, errors };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push({ message: "Expected a JSON object (Record<string, string>)" });
    return { entries: {}, errors };
  }

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      errors.push({ message: `Non-string value for key "${key}"` });
      continue;
    }
    entries[key] = value;
  }

  return { entries, errors };
}

function parseDotLang(content: string): LangFileParseResult {
  const errors: LangFileParseResult["errors"] = [];
  const entries: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      errors.push({
        line: i + 1,
        message: `Line does not contain "=" separator`,
      });
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1);

    if (key.length === 0) {
      errors.push({ line: i + 1, message: `Empty key before "="` });
      continue;
    }

    entries[key] = value;
  }

  return { entries, errors };
}

// ──────────────────────────────────────────
// Serialize
// ──────────────────────────────────────────

/**
 * Serialize a key-value map to a Minecraft language file string.
 */
export function dumpLangFile(
  entries: Record<string, string>,
  format: LanguageFileFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(entries, null, 4)}\n`;
  }

  // .lang format: keys sorted, key=value, trailing newline
  const sortedKeys = Object.keys(entries).sort();
  const lines: string[] = [];
  for (const key of sortedKeys) {
    const value = entries[key]!;
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}



/**
 * Parse language file content (JSON or .lang) into a flat key-value map.
 * Auto-detects format: tries JSON first, falls back to .lang format.
 * Returns empty object for empty/null content.
 */
export function parseTranslationContent(content: string): Record<string, string> {
  if (!content) return {};
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") result[key] = value;
      }
      return result;
    } catch {
      // fall through to .lang parse
    }
  }
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const ln = line.trim();
    if (ln === "" || ln.startsWith("#") || ln.startsWith("//")) continue;
    const eqIdx = ln.indexOf("=");
    if (eqIdx === -1) continue;
    const key = ln.slice(0, eqIdx).trim();
    const val = ln.slice(eqIdx + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}
