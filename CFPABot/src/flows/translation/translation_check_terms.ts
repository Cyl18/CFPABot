// src/flows/translation/translation_check_terms.ts
// Flow: translation_check_terms — check translation entries against terminology rules.
// Pure check, no side effects (risk=read). Reuses _shared/terminology/check-terms.
// Same pure function used by info-comment checks and Compare page.
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { checkAllTerms, formatTermFindings } from "../_shared/terminology/index.js";
import { getDefaultRules, filterRulesByVersion } from "../_shared/terminology/index.js";
import type { TermRule } from "../_shared/types.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const translation_check_terms_input = Type.Object({
  entries: Type.Record(Type.String(), Type.String(), {
    description: "zh_cn key-value pairs to check",
  }),
  mcVersion: Type.Optional(
    Type.String({ description: "Optional Minecraft version for rule filtering" }),
  ),
  ruleSetVersion: Type.Optional(
    Type.String({ description: "Optional rule set version identifier" }),
  ),
  additionalRules: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        pattern: Type.String(),
        level: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
        message: Type.String(),
      }),
      { description: "Additional term rules to apply alongside defaults" },
    ),
  ),
});

export type TranslationCheckTermsInput = Static<typeof translation_check_terms_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const translation_check_terms_output = Type.Object({
  findings: Type.Array(
    Type.Object({
      key: Type.String(),
      value: Type.String(),
      code: Type.String({ description: "Finding code (e.g. term_T001)" }),
      severity: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
      message: Type.String(),
      ruleId: Type.String({ description: "Matching term rule ID" }),
    }),
  ),
  totalChecked: Type.Number({ description: "Number of entries checked" }),
  totalWarnings: Type.Number(),
  totalErrors: Type.Number(),
});

export type TranslationCheckTermsOutput = Static<typeof translation_check_terms_output>;

// ─── Flow Definition ────────────────────────────────────────────────────

export const translation_check_terms: Flow<typeof translation_check_terms_input, typeof translation_check_terms_output> = {
  name: "translation_check_terms",
  description: "Check zh_cn translation entries against terminology rules. Returns warnings/errors per key with the matching rule ID and message. Supports optional Minecraft version filtering and additional rules.",
  input: translation_check_terms_input,
  output: translation_check_terms_output,
  meta: {
    tags: ["pr", "query", "review"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof translation_check_terms_input>): Promise<Static<typeof translation_check_terms_output>> {
    const { entries, mcVersion, additionalRules } = input;

    // Build rule set
    let rules: TermRule[] = getDefaultRules();

    // Filter by MC version if specified
    if (mcVersion) {
      rules = filterRulesByVersion(rules, mcVersion);
    }

    // Merge additional rules
    if (additionalRules && additionalRules.length > 0) {
      rules = [
        ...rules,
        ...additionalRules.map((r) => ({
          id: r.id,
          pattern: r.pattern,
          level: r.level,
          message: r.message,
        })),
      ];
    }

    // Check all entries
    const matched = checkAllTerms(entries, rules);

    // Count by severity
    let totalWarnings = 0;
    let totalErrors = 0;
    const findings = matched.map((m) => {
      if (m.level === "error") totalErrors++;
      else totalWarnings++;
      return {
        key: m.key,
        value: m.value,
        code: `term_${m.ruleId}`,
        severity: m.level,
        message: m.message,
        ruleId: m.ruleId,
      };
    });

    return {
      findings,
      totalChecked: Object.keys(entries).length,
      totalWarnings,
      totalErrors,
    };
  },
};
