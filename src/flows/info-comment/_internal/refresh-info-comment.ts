// src/flows/info-comment/_internal/refresh-info-comment.ts
// Domain internal: refresh the info comment for a PR.
// Called by info_comment_refresh, info_comment_refresh_artifacts, info_comment_force_refresh.
// Uses process lock + revision check to prevent concurrent updates.

import type { FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { acquireLock } from "@/engine/lock.js";
import type {
  InfoCommentSectionStates,
  SectionResult,
} from "../../_shared/types.js";
import {
  loadInfoCommentState,
  saveInfoCommentState,
  createPendingState,
  buildNextState,
  invalidateSections,
  sectionResultToState,
} from "../state.js";
import { deliverInfoComment } from "./deliver-comment.js";
import type { DeliverInfoCommentResult } from "./deliver-comment.js";
import { collectMods } from "./collect-mods.js";
import { collectArtifacts } from "./collect-artifacts.js";
import { collectChecks } from "./collect-checks.js";
import { collectTranslationDiff } from "./collect-translation-diff.js";

// ─── Options ────────────────────────────────────────────────────────

export interface RefreshInfoCommentOptions {
  prNumber: number;
  headSha: string;
  baseSha?: string;
  /** Which sections to collect. Default: all four. */
  sections?: Array<keyof InfoCommentSectionStates>;
  /** Workflow run ID for artifact collection (from workflow_run webhook). */
  workflowRunId?: number;
  /** If true, invalidate all cachable sections before collecting. */
  forceInvalidate?: boolean;
  /** Write an "updating" preview before starting collection. */
  writePreview?: boolean;
  /** Reason for the refresh (for logging). */
  reason?: string;
}

export interface RefreshInfoCommentResult {
  commentId: number;
  revision: number;
  sectionStates: Record<string, "pending" | "ready" | "empty" | "error">;
  oversized: boolean;
  gistUrl?: string;
}

// ─── Main internal operation ────────────────────────────────────────

/**
 * Refresh the info comment for a PR.
 *
 * 1. Acquire process lock `info-comment:{owner}/{repo}/{pr}`.
 * 2. Load existing state or create pending.
 * 3. Optionally write "updating" preview.
 * 4. Collect sections (parallel, independent).
 * 5. Merge results into state.
 * 6. Deliver (render + upsert) to GitHub.
 * 7. Save new revision on success.
 *
 * On final GitHub write failure, does NOT save new revision — preserves old state.
 */
export async function refreshInfoComment(
  ctx: FlowContext,
  options: RefreshInfoCommentOptions,
): Promise<RefreshInfoCommentResult> {
  const { prNumber, headSha, baseSha, sections: sectionNames, workflowRunId, forceInvalidate, writePreview, reason } = options;
  const repoKey = `${ctx.repo.owner}/${ctx.repo.name}`;

  // 1. Acquire per-PR lock
  const lockKey = `info-comment:${repoKey}/${prNumber}`;
  const release = await acquireLock(lockKey);
  try {
    // 2. Load existing state
    let state = await loadInfoCommentState(ctx.store, ctx.repo.owner, ctx.repo.name, prNumber);

    if (!state) {
      // No existing state — create pending
      state = createPendingState(repoKey, prNumber, headSha);
    } else if (state.headSha !== headSha) {
      // Head SHA changed — reset state but keep commentId
      const commentId = state.commentId;
      state = createPendingState(repoKey, prNumber, headSha);
      if (commentId) state.commentId = commentId;
    }

    // 2b. Force invalidate if requested
    if (forceInvalidate) {
      state = invalidateSections(state);
    }

    const expectedRevision = state.revision;

    // 3. Write "updating" preview
    if (writePreview) {
      const updatingState = {
        ...state,
        sections: { ...state.sections },
      };
      await deliverInfoComment(ctx, prNumber, updatingState, {
        isUpdating: true,
        updatingHeadSha: headSha,
      });
    }

    // 4. Collect sections — independent parallel execution
    const names = sectionNames ?? (["mods", "artifacts", "checks", "translationDiff"] as const);
    const newSections: Partial<InfoCommentSectionStates> = {};
    for (const name of names) {
      const result = await collectSingleSection(ctx, name, prNumber, headSha, baseSha, workflowRunId);
      if (result) {
        // Convert SectionResult to SectionState and attach to sections
        (newSections as Record<string, unknown>)[name] = sectionResultToState(result);
      }
    }

    // 5. Build next state
    state = buildNextState(state, headSha, {
      ...state.sections,
      ...newSections,
    });

    // 6. Deliver to GitHub
    let deliverResult: DeliverInfoCommentResult;
    try {
      deliverResult = await deliverInfoComment(ctx, prNumber, state);
    } catch (err: unknown) {
      // Final write failure — do NOT save new revision
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ prNumber, headSha, err: msg }, "info-comment: final deliver failed, preserving old state");
      throw new FlowError({
        code: "FAILED",
        message: msg,
        publicMessage: `GitHub 评论写入失败: ${msg}`,
        retryable: true,
        details: { prNumber },
      });
    }

    // Store commentId in state
    state.commentId = deliverResult.commentId;

    // 7. Save new revision with expectedRevision check
    const saveResult = await saveInfoCommentState(
      ctx.store, ctx.repo.owner, ctx.repo.name, prNumber, state,
      { expectedRevision },
    );

    if (!saveResult.saved) {
      // Revision mismatch — record critical, return partial failure
      ctx.logger.error(
        { prNumber, expectedRevision, actualRevision: saveResult.actualRevision },
        "info-comment: state revision mismatch on save",
      );
      throw new FlowError({
        code: "FAILED",
        message: `State revision mismatch: expected ${expectedRevision}, got ${saveResult.actualRevision}`,
        publicMessage: "状态保存冲突，请重试",
        retryable: true,
        details: { prNumber, expectedRevision, actualRevision: saveResult.actualRevision },
      });
    }

    // Build section status map for output
    const sectionStates: Record<string, "pending" | "ready" | "empty" | "error"> = {};
    for (const [key, sec] of Object.entries(state.sections)) {
      sectionStates[key] = sec.status;
    }

    return {
      commentId: deliverResult.commentId,
      revision: state.revision,
      sectionStates,
      oversized: deliverResult.oversized,
      gistUrl: deliverResult.gistUrl,
    };
  } finally {
    release();
  }
}

// ─── Single section collection ──────────────────────────────────────

/**
 * Collect a single section by dispatching to the appropriate collector.
 * The caller controls which sections to collect; this function simply
 * routes to each domain collector with the right parameters.
 */
async function collectSingleSection(
  ctx: FlowContext,
  name: keyof InfoCommentSectionStates,
  prNumber: number,
  headSha: string,
  baseSha: string | undefined,
  workflowRunId?: number,
): Promise<SectionResult<unknown> | null> {
  switch (name) {
    case "mods":
      return collectMods(ctx, prNumber, headSha);
    case "artifacts":
      return collectArtifacts(ctx, prNumber, headSha, workflowRunId);
    case "checks":
      return collectChecks(ctx, prNumber, headSha);
    case "translationDiff":
      if (!baseSha) return null;
      return collectTranslationDiff(ctx, prNumber, headSha, baseSha);
    default:
      return null;
  }
}
