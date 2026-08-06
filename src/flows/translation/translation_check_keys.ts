// src/flows/translation/translation_check_keys.ts
// Flow: translation_check_keys — analyze language file key issues: missing keys
// (en_us baseline), anomalous duplicates, en/cn mismatches, combined file detection.
// Risk: read | Effects: github_read
// Reuses _shared/language/key-analyzer pure functions.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import {
  findMissingKeys,
  findUntranslatedKeys,
  findSuspiciousTranslations,
  countKeysByConvention,
} from "../_shared/language/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const translation_check_keys_input = Type.Object({
  enUs: Type.Record(Type.String(), Type.String(), {
    description: "English (en_us) key-value entries (baseline)",
  }),
  zhCn: Type.Record(Type.String(), Type.String(), {
    description: "Chinese (zh_cn) key-value entries to check",
  }),
  modSlug: Type.Optional(
    Type.String({ description: "Optional mod slug for combined file detection" }),
  ),
});

export type TranslationCheckKeysInput = Static<typeof translation_check_keys_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const translation_check_keys_output = Type.Object({
  missingKeyNames: Type.Array(Type.String(), {
    description: "Keys in en_us but missing from zh_cn",
  }),
  extraKeyNames: Type.Array(Type.String(), {
    description: "Keys in zh_cn with no en_us counterpart",
  }),
  missingCount: Type.Number(),
  extraCount: Type.Number(),
  untranslatedKeys: Type.Array(
    Type.Object({
      key: Type.String(),
      english: Type.String(),
      chinese: Type.String(),
    }),
  ),
  suspiciousKeys: Type.Array(
    Type.Object({
      key: Type.String(),
      value: Type.String(),
      reason: Type.String(),
    }),
  ),
  keyConventions: Type.Record(Type.String(), Type.Number(), {
    description: "Count of keys per naming convention",
  }),
  totalEnUs: Type.Number(),
  totalZhCn: Type.Number(),
  isCombinedFile: Type.Optional(
    Type.Boolean({ description: "Likely a combined/merged language file" }),
  ),
  combinedFileReason: Type.Optional(Type.String()),
});

export type TranslationCheckKeysOutput = Static<typeof translation_check_keys_output>;

// ─── Flow Definition ────────────────────────────────────────────────────

export const translation_check_keys: Flow<typeof translation_check_keys_input, typeof translation_check_keys_output> = {
  name: "translation_check_keys",
  description: "Analyze language file key issues: missing keys (en_us baseline present but zh_cn absent), extra zh_cn keys without en_us counterpart, untranslated keys (Chinese equals English), suspicious translations (placeholder leftovers), and key naming convention distribution.",
  input: translation_check_keys_input,
  output: translation_check_keys_output,
  meta: {
    tags: ["pr", "query", "review"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof translation_check_keys_input>): Promise<Static<typeof translation_check_keys_output>> {
    const { enUs, zhCn, modSlug } = input;

    // 1. Find missing keys (en_us present but zh_cn absent)
    const missing = findMissingKeys(enUs, zhCn);

    // 2. Find untranslated keys (zh_cn == en_us)
    const untranslated = findUntranslatedKeys(enUs, zhCn);

    // 3. Find suspicious translations
    const suspicious = findSuspiciousTranslations(zhCn);

    // 4. Key naming conventions
    const conventions = countKeysByConvention(zhCn);

    // 5. Detect combined file heuristic
    const isCombinedFile = detectCombinedFile(enUs, modSlug);
    let combinedFileReason: string | undefined;
    if (isCombinedFile) {
      combinedFileReason = modSlug
        ? `文件可能包含了多个模组的键（基于 modSlug: ${modSlug} 的检测）`
        : "文件包含异常大量的键，可能为合并文件";
    }

    return {
      missingKeyNames: missing.missing,
      extraKeyNames: missing.extra,
      missingCount: missing.missingCount,
      extraCount: missing.extraCount,
      untranslatedKeys: untranslated.map((u) => ({
        key: u.key,
        english: u.english,
        chinese: u.chinese,
      })),
      suspiciousKeys: suspicious.map((s) => ({
        key: s.key,
        value: s.value,
        reason: s.reason,
      })),
      keyConventions: conventions,
      totalEnUs: Object.keys(enUs).length,
      totalZhCn: Object.keys(zhCn).length,
      isCombinedFile,
      combinedFileReason,
    };
  },
};

// ─── Heuristic: combined file detection ─────────────────────────────────

/**
 * Heuristic to detect if a language file appears to be a combined/merged file
 * rather than a single-mod language file. Mod slug context helps refine the check.
 *
 * A file with >5000 keys is likely a combined file.
 */
function detectCombinedFile(
  enUs: Record<string, string>,
  modSlug?: string,
): boolean {
  const keyCount = Object.keys(enUs).length;
  if (keyCount > 5000) return true;

  // Check for multiple mod prefixes in key names
  if (modSlug) {
    const prefixes = new Set<string>();
    for (const key of Object.keys(enUs)) {
      const parts = key.split(".");
      if (parts.length >= 2) {
        prefixes.add(parts[0]!);
      }
      if (prefixes.size > 3) return true;
    }
  }

  return false;
}
