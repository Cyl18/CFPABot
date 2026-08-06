// src/flows/info-comment/_internal/deliver-comment.ts
// Deliver/render the info comment to GitHub: create, update, or Gist-fallback.
// Uses the <!--CYBOT--> marker for comment discovery.

import type { FlowContext } from "@/types.js";
import type { InfoCommentState, PublicError } from "../../_shared/types.js";
import { renderInfoComment } from "../../_shared/markdown/index.js";

// ─── Constants ──────────────────────────────────────────────────────

const MAX_COMMENT_CHARS = 65_000;
const MAX_DIFF_SECTION_CHARS = 20_000;

// ─── Options & Result ───────────────────────────────────────────────

export interface DeliverInfoCommentOptions {
  /** Exhibit "updating" preamble */
  isUpdating?: boolean;
  /** Custom head SHA for the updating header */
  updatingHeadSha?: string;
  /** Prefer creating a Gist for oversized content */
  preferGist?: boolean;
}

export interface DeliverInfoCommentResult {
  commentId: number;
  gistId?: string;
  gistUrl?: string;
  oversized: boolean;
  truncatedSection: boolean;
}

// ─── Main deliver function ──────────────────────────────────────────

/**
 * Find or create the <!--CYBOT--> comment, then upsert the rendered content.
 *
 * Steps:
 * 1. Find existing <!--CYBOT--> comment on the PR.
 * 2. If not found, create a new initial/updating comment.
 * 3. Render final content from state.
 * 4. Check size — apply section or full Gist fallback if needed.
 * 5. Update or create the comment.
 * 6. Return comment metadata.
 *
 * On final write failure, keeps old state — does NOT save new revision.
 */
export async function deliverInfoComment(
  ctx: FlowContext,
  prNumber: number,
  state: InfoCommentState,
  options?: DeliverInfoCommentOptions,
): Promise<DeliverInfoCommentResult> {
  // ── Find existing CYBOT comment ──
  let existingComment: { id: number; body: string } | null = await ctx.github.findBotComment(prNumber);

  // If no comment found via bot login search, scan all comments for marker
  if (!existingComment) {
    existingComment = await findCybotComment(ctx, prNumber);
  }

  // ── Render the comment body ──
  const body = renderInfoComment(state, {
    isUpdating: options?.isUpdating,
    updatingHeadSha: options?.updatingHeadSha,
    maxDiffSectionChars: MAX_DIFF_SECTION_CHARS,
  });

  // ── Size check and Gist fallback ──
  let finalBody = body;
  let truncatedSection = false;
  let gistId: string | undefined;
  let gistUrl: string | undefined;
  let oversized = false;

  if (body.length > MAX_COMMENT_CHARS) {
    // Full comment too large — upload complete Markdown to Gist
    const gistContent = buildGistContent(state, body);
    try {
      const gist = await ctx.github.createGist(
        gistContent,
        gistFilename(state),
      );
      gistId = gist.id;
      gistUrl = gist.html_url;
      oversized = true;
      // Render a compact summary for the comment body
      finalBody = renderCompactSummary(state, gistUrl);
    } catch {
      // Gist failed — keep old state, do NOT save new revision
      throw new GistFallbackError(
        "完整评论超出 GitHub 限制，且 Gist 上传失败",
      );
    }
  }

  // ── Upsert comment ──
  let comment;
  try {
    if (existingComment) {
      comment = await ctx.github.updateIssueComment(existingComment.id, finalBody);
    } else {
      comment = await ctx.github.createIssueComment(prNumber, finalBody);
    }
  } catch (err: unknown) {
    // Final write failure — do NOT save new revision
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GitHub comment write failed for PR #${prNumber}: ${msg}`,
    );
  }

  return {
    commentId: comment.id,
    gistId,
    gistUrl,
    oversized,
    truncatedSection,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Search all PR comments for the <!--CYBOT--> marker.
 * Used for first discovery when findBotComment returns null.
 */
async function findCybotComment(
  ctx: FlowContext,
  prNumber: number,
): Promise<{ id: number; body: string } | null> {
  try {
    const comments = await ctx.github.getPrComments(prNumber);
    for (const c of comments) {
      if (c.body?.includes("<!--CYBOT-->")) {
        return { id: c.id, body: c.body ?? "" };
      }
    }
  } catch {
    // Non-critical — creation will handle it
  }
  return null;
}

/**
 * Build the Gist content as a single-file gist.
 * Uses the full rendered Markdown.
 */
function buildGistContent(state: InfoCommentState, fullBody: string): string {
  return fullBody;
}

/**
 * Generate a deterministic filename for the Gist.
 * Format: cfpa-info-{prNumber}-{headSha-short}-{contentHash-short}.md
 */
function gistFilename(state: InfoCommentState): string {
  const headShort = state.headSha.slice(0, 7);
  return `cfpa-info-${state.prNumber}-${headShort}.md`;
}

/**
 * Render a compact summary of section states when the full comment
 * is too large and has been uploaded to a Gist.
 */
function renderCompactSummary(
  state: InfoCommentState,
  gistUrl: string,
): string {
  const parts: string[] = [];

  parts.push("<!--CYBOT-->");
  parts.push("");
  parts.push("## 🤖 CFPA Bot 信息评论");
  parts.push("");

  // Section status summary
  const sections = state.sections;
  const statuses: string[] = [];

  if (sections.mods.status !== "pending") statuses.push(`📦 Mod: ${sections.mods.status}`);
  if (sections.artifacts.status !== "pending") statuses.push(`📦 Packer: ${sections.artifacts.status}`);
  if (sections.checks.status !== "pending") statuses.push(`✅ 检查: ${sections.checks.status}`);
  if (sections.translationDiff.status !== "pending") statuses.push(`🌐 翻译: ${sections.translationDiff.status}`);

  if (statuses.length > 0) {
    parts.push("| Section | 状态 |");
    parts.push("| --- | --- |");
    for (const s of statuses) {
      parts.push(`| ${s} |`);
    }
    parts.push("");
  }

  parts.push(`> 完整评论已上传至 [私有 Gist](${gistUrl})。`);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("> 此评论由程序自动维护。");
  parts.push("");
  parts.push("- [ ] 强制刷新所有信息");
  parts.push("");

  return parts.join("\n");
}

// ─── Custom error ───────────────────────────────────────────────────

export class GistFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GistFallbackError";
  }
}
