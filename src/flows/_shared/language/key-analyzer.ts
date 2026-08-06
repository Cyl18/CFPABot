// src/flows/_shared/language/key-analyzer.ts
// PURE: Key-level analysis of language file entries.
// No I/O, no globals, no side effects.

import type { LangDiffResult } from "../types.js";

export interface MissingKeyResult {
  /** Keys present in en_us but missing from zh_cn */
  missing: string[];
  /** Keys present in zh_cn but not in en_us (possibly stale/extra) */
  extra: string[];
  /** Total missing count */
  missingCount: number;
  /** Total extra count */
  extraCount: number;
}

export interface KeyNamingIssue {
  key: string;
  issue: string;
}

// ──────────────────────────────────────────
// Missing key detection (en_us baseline)
// ──────────────────────────────────────────

/**
 * Find keys present in en_us entries but missing in zh_cn entries.
 * Also reports keys in zh_cn that have no en_us counterpart.
 */
export function findMissingKeys(
  enUsEntries: Record<string, string>,
  zhCnEntries: Record<string, string>,
): MissingKeyResult {
  const missing: string[] = [];
  const extra: string[] = [];

  for (const key of Object.keys(enUsEntries)) {
    if (!(key in zhCnEntries)) {
      missing.push(key);
    }
  }

  for (const key of Object.keys(zhCnEntries)) {
    if (!(key in enUsEntries)) {
      extra.push(key);
    }
  }

  return {
    missing,
    extra,
    missingCount: missing.length,
    extraCount: extra.length,
  };
}

// ──────────────────────────────────────────
// Key pattern analysis
// ──────────────────────────────────────────

/** Known key naming convention patterns for Minecraft mods. */
const CONVENTION_PATTERNS = [
  { name: "item group", re: /^itemGroup\b/ },
  { name: "tile/block", re: /^tile\./ },
  { name: "item", re: /^item\./ },
  { name: "entity", re: /^entity\./ },
  { name: "container", re: /^container\./ },
  { name: "gui", re: /^gui\./ },
  { name: "advancement", re: /^advancements?\./ },
  { name: "biome", re: /^biome\./ },
  { name: "effect/potion", re: /^(effect|potion)\./ },
  { name: "enchantment", re: /^enchantment\./ },
  { name: "key/category", re: /^key\./ },
  { name: "command", re: /^commands?\./ },
  { name: "stat", re: /^stat\./ },
  { name: "subtitles", re: /^subtitles?\./ },
  { name: "death", re: /^death\./ },
  { name: "chat", re: /^chat\./ },
  { name: "config", re: /^config\./ },
  { name: "tooltip", re: /^tooltip\./ },
  { name: "message", re: /^message\./ },
  { name: "keybind", re: /^keybind\./ },
] as const;

/**
 * Classify a key by its prefix convention.
 * Returns the convention name or "unknown".
 */
export function classifyKey(key: string): string {
  for (const { name, re } of CONVENTION_PATTERNS) {
    if (re.test(key)) return name;
  }
  return "unknown";
}

/**
 * Count keys by convention type.
 */
export function countKeysByConvention(
  entries: Record<string, string>,
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const key of Object.keys(entries)) {
    const type = classifyKey(key);
    counts[type] = (counts[type] ?? 0) + 1;
  }

  return counts;
}

// ──────────────────────────────────────────
// Translation quality heuristics
// ──────────────────────────────────────────

/**
 * Detect keys whose Chinese translation equals the English source,
 * which likely means the key was left untranslated.
 */
export function findUntranslatedKeys(
  enUsEntries: Record<string, string>,
  zhCnEntries: Record<string, string>,
): Array<{ key: string; english: string; chinese: string }> {
  const result: Array<{ key: string; english: string; chinese: string }> = [];

  for (const key of Object.keys(zhCnEntries)) {
    const zh = zhCnEntries[key]!;
    const en = enUsEntries[key];
    if (en !== undefined && zh === en && /[a-zA-Z]/.test(zh)) {
      result.push({ key, english: en, chinese: zh });
    }
  }

  return result;
}

/**
 * Detect suspiciously short or incomplete-looking translations.
 */
export function findSuspiciousTranslations(
  zhCnEntries: Record<string, string>,
): Array<{ key: string; value: string; reason: string }> {
  const result: Array<{ key: string; value: string; reason: string }> = [];

  for (const [key, value] of Object.entries(zhCnEntries)) {
    if (value.length === 0) {
      result.push({ key, value, reason: "empty_value" });
    } else if (value.length <= 2 && /^[\x00-\x7F]+$/.test(value)) {
      // Very short ASCII-only values are likely placeholders
      result.push({ key, value, reason: "too_short" });
    } else if (/^[{[]/.test(value) && /[}\]]$/.test(value)) {
      // Value looks like a format string only (e.g. "%s")
      result.push({ key, value, reason: "format_only" });
    }
  }

  return result;
}
