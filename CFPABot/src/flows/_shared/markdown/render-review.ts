// src/flows/_shared/markdown/render-review.ts
// PURE: Render Agent Review summary and inline findings as Markdown.
// No I/O, no globals, no side effects.

import type { ReviewDraft, ReviewFinding, Severity } from "../types.js";
import { escapeMarkdown } from "./escape.js";

// ──────────────────────────────────────────
// Main review renderer
// ──────────────────────────────────────────

export interface RenderReviewOptions {
  /** Session ID for the marker */
  sessionId: string;
  /** Short display for head SHA */
  headSha: string;
}

/**
 * Render a full Agent Review summary comment Markdown.
 * This is the summary comment posted on the PR timeline - inline review
 * comments are posted separately via the GitHub Review API.
 */
export function renderReviewSummary(
  draft: ReviewDraft,
  options: RenderReviewOptions,
): string {
  const parts: string[] = [];

  // 1. Marker
  parts.push(
    `<!-- CFPABOT:AGENT_REVIEW session=${options.sessionId} head=${options.headSha} -->`,
  );
  parts.push("");

  // 2. Header
  parts.push(`## 🔍 Agent Review - ${formatKind(draft.kind)}`);
  parts.push("");

  parts.push(
    `> Head: \`${options.headSha.slice(0, 7)}\` | Session: \`${options.sessionId.slice(0, 8)}…\``,
  );
  parts.push("");

  // 3. Summary
  parts.push("### 总结");
  parts.push("");
  parts.push(draft.summary);
  parts.push("");

  // Separate inline vs non-inline findings
  const inlineFindings = draft.findings.filter((f) => f.path !== undefined);
  const summaryFindings = draft.findings.filter((f) => f.path === undefined);

  // 4. Non-inline findings grouped by severity
  if (summaryFindings.length > 0) {
    parts.push("### 审查发现");
    parts.push("");

    for (const severity of ["error", "warning", "info"] as Severity[]) {
      const group = summaryFindings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;

      const icon = severity === "error" ? "🔴" : severity === "warning" ? "🟡" : "🔵";
      parts.push(`#### ${icon} ${capitalize(severity)} (${group.length})`);
      parts.push("");

      for (const finding of group) {
        parts.push(renderFindingBlock(finding));
      }
    }
  }

  // 5. Inline findings count
  if (inlineFindings.length > 0) {
    parts.push("### 行内评论");
    parts.push("");
    parts.push(
      `共 ${inlineFindings.length} 条行内审查意见，已发布在对应文件位置。`,
    );
    parts.push("");
  }

  // 6. Footer
  parts.push("---");
  parts.push("");
  parts.push(
    "_此审查由 AI Agent 自动生成，由管理员触发。请人工复核后决定是否采纳。_",
  );
  parts.push("");

  return parts.join("\n");
}

 // ──────────────────────────────────────────
 // Single finding renderer
 // ──────────────────────────────────────────

/**
 * Render a single finding as a Markdown block.
 * Suitable for both summary and standalone display.
 */
export function renderFindingBlock(finding: ReviewFinding): string {
  const parts: string[] = [];

  const severityIcon =
    finding.severity === "error"
      ? "🔴"
      : finding.severity === "warning"
        ? "🟡"
        : "🔵";

  const title = escapeMarkdown(finding.title);
  const category = finding.category;

  parts.push(
    `<details>`,
    `<summary>${severityIcon} **${title}** — _${category}_</summary>`,
    ``,
  );

  // Evidence
  if (finding.evidence) {
    parts.push("**依据：**", "");
    parts.push(`> ${escapeMarkdown(finding.evidence)}`, "");
  }

  // Explanation
  if (finding.explanation) {
    parts.push("**说明：**", "");
    parts.push(escapeMarkdown(finding.explanation), "");
  }

  // Suggestion
  if (finding.suggestion) {
    parts.push("**建议：**", "");
    parts.push("```", finding.suggestion, "```", "");
  }

  // Location
  if (finding.path) {
    const loc = finding.line
      ? `${finding.path}:${finding.line}`
      : finding.path;
    const side = finding.side ? ` (${finding.side})` : "";
    parts.push(`_位置: \`${escapeMarkdown(loc)}\`${side}_`, "");
  }

  parts.push(`</details>`, "");
  parts.push("");

  return parts.join("\n");
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function formatKind(kind: ReviewDraft["kind"]): string {
  switch (kind) {
    case "code":
      return "代码审查";
    case "translation":
      return "翻译审查";
    case "mixed":
      return "综合审查";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
