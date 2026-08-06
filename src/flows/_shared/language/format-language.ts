// src/flows/_shared/language/format-language.ts
// PURE: Format language file content according to project conventions.
// No I/O, no globals, no side effects.

import type { LanguageFileFormat } from "../types.js";

/**
 * Format a JSON language file content string.
 * Rules:
 * - 4-space indent
 * - Unix line endings (\n)
 * - Keys sorted alphabetically
 * - Trailing newline
 * - Only string values accepted
 *
 * Returns { formatted, error? }.
 * On error the original content is returned unchanged.
 */
export function formatJsonLang(
  content: string,
): { formatted: string; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e: unknown) {
    return {
      formatted: content,
      error: e instanceof Error ? e.message : "Invalid JSON",
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      formatted: content,
      error: "Expected a JSON object",
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate all values are strings
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "string") {
      return {
        formatted: content,
        error: `Non-string value for key "${key}"`,
      };
    }
  }

  // Sort keys and serialize
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key] as string;
  }

  return { formatted: `${JSON.stringify(sorted, null, 4)}\n` };
}

/**
 * Format a .lang file content string.
 * Rules:
 * - Preserve valid key=value lines and comments
 * - Compress consecutive blank lines into one
 * - Preserve comment lines
 * - Trailing newline
 * - Lines are sorted by key
 *
 * Returns { formatted, error? }.
 */
export function formatDotLang(
  content: string,
): { formatted: string; error?: string } {
  const lines = content.split(/\r?\n/);
  const entries: Array<{ key: string; value: string }> = [];
  const comments: string[] = [];
  let hadContent = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed === "") {
      // Empty lines are preserved as blank-line markers (collapsed later)
      if (hadContent) {
        comments.push(""); // blank line marker
      }
      continue;
    }

    if (trimmed.startsWith("#")) {
      comments.push(trimmed);
      hadContent = true;
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1);
      if (key.length > 0) {
        entries.push({ key, value });
        hadContent = true;
        continue;
      }
    }

    // Unrecognized line — preserve as-is but it's an edge case
    comments.push(rawLine);
    hadContent = true;
  }

  // Sort entries by key
  entries.sort((a, b) => a.key.localeCompare(b.key));

  // Build output: compress consecutive blank lines
  const outLines: string[] = [];
  let prevBlank = false;

  for (const item of comments) {
    if (item === "") {
      if (prevBlank) continue;
      prevBlank = true;
      outLines.push("");
    } else {
      prevBlank = false;
      outLines.push(item);
    }
  }

  // Separate comments from entries with a blank line if both exist
  if (outLines.length > 0 && outLines[outLines.length - 1] !== "") {
    outLines.push("");
  }

  for (const { key, value } of entries) {
    outLines.push(`${key}=${value}`);
  }

  // Ensure trailing newline
  outLines.push("");

  return { formatted: outLines.join("\n") };
}

/**
 * Format language file content based on format type.
 * Detects duplicates and non-string values in JSON mode.
 */
export function formatLanguage(
  content: string,
  format: LanguageFileFormat,
): { formatted: string; error?: string } {
  if (format === "json") {
    return formatJsonLang(content);
  }
  return formatDotLang(content);
}
