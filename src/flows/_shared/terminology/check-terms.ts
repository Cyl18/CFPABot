// src/flows/_shared/terminology/check-terms.ts
// PURE: Check translations against terminology rules.
// No I/O, no globals, no side effects.

import type { TermRule, MatchedTerm } from "../types.js";
import { getDefaultRules } from "./rules.js";

/**
 * Check a single Chinese translation value against a set of term rules.
 * Returns all rules that match (active violations).
 */
export function checkValue(
  key: string,
  value: string,
  rules: TermRule[],
): MatchedTerm[] {
  const matched: MatchedTerm[] = [];

  for (const rule of rules) {
    // Check exceptions first
    if (rule.exceptions && rule.exceptions.length > 0) {
      if (rule.exceptions.includes(value)) continue;
    }

    // Check if the pattern appears in the value
    if (value.includes(rule.pattern)) {
      matched.push({
        ruleId: rule.id,
        key,
        value,
        level: rule.level,
        message: rule.message,
      });
    }
  }

  return matched;
}

/**
 * Check all entries in a zh_cn language file against the default term rules.
 * Returns all term violations found.
 *
 * @param zhCnEntries - The parsed zh_cn key-value entries
 * @param rules - Rules to check against; defaults to getDefaultRules() if omitted
 */
export function checkAllTerms(
  zhCnEntries: Record<string, string>,
  rules?: TermRule[],
): MatchedTerm[] {
  const activeRules = rules ?? getDefaultRules();
  const results: MatchedTerm[] = [];

  for (const [key, value] of Object.entries(zhCnEntries)) {
    const matched = checkValue(key, value, activeRules);
    results.push(...matched);
  }

  return results;
}

/**
 * Convert MatchedTerm array to human-readable finding messages.
 * Each finding combines the key, the offending value, and the rule message.
 */
export function formatTermFindings(
  findings: MatchedTerm[],
): Array<{ message: string; severity: "warning" | "error"; code: string }> {
  return findings.map((f) => ({
    message: `[${f.key}] ${f.message}: "${f.value}"`,
    severity: f.level,
    code: `term_${f.ruleId}`,
  }));
}
