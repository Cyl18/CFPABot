// src/agent/flow-policy.ts
// Agent tool visibility policy.
//
// This is intentionally narrower than Flow.meta.agent_callable. After the
// 2026-08-01 incident where review_comment published a public PR comment from
// a verification session, the default posture is deny-list: only flows
// explicitly listed here are exposed as Agent tools. Re-opening a Flow for
// Agent use is a deliberate policy change, not a metadata edit.

export const AGENT_FLOW_WHITELIST: ReadonlySet<string> = new Set([
  "pr_get_context",
  "pr_get_detail",
  "pr_get_diff",
  "pr_read_file",
  "pr_compare",
  "pr_find_related",
  // Terminology tools
  "terms_ngram_build",
  "tm_build",
  // Manual rules
  "manual_rule_promote",
]);

export function isAgentVisible(flowName: string): boolean {
  return AGENT_FLOW_WHITELIST.has(flowName);
}
