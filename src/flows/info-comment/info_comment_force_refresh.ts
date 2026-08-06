// src/flows/info-comment/info_comment_force_refresh.ts
// Flow: info_comment_force_refresh — force invalidate all section caches and re-collect.
// Risk: repository_write | Effects: github_comment_write, github_read, storage_write
// Used for admin force refresh (e.g., checkbox on comment).

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { refreshInfoComment } from "./_internal/index.js";
import { loadPrSnapshot } from "../_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────

export const info_comment_force_refresh_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA — fails STALE_HEAD if mismatch" }),
  requestedBy: Type.String({ description: "Admin login who requested the force refresh" }),
});

export type InfoCommentForceRefreshInput = Static<typeof info_comment_force_refresh_input>;

// ─── Output DTO ────────────────────────────────────────────────────

export const info_comment_force_refresh_output = Type.Object({
  commentId: Type.Number({ description: "GitHub comment ID" }),
  revision: Type.Number({ description: "New state revision" }),
  invalidatedSections: Type.Array(Type.String(), {
    description: "Sections that were invalidated and re-collected",
  }),
  sectionStates: Type.Record(
    Type.String(),
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("ready"),
      Type.Literal("empty"),
      Type.Literal("error"),
    ]),
    { description: "Status of each section after refresh" },
  ),
  oversized: Type.Boolean({ description: "True if the comment exceeded GitHub size limit and used Gist fallback" }),
  gistUrl: Type.Optional(Type.String({ description: "URL to Gist if oversized fallback was used" })),
});

export type InfoCommentForceRefreshOutput = Static<typeof info_comment_force_refresh_output>;

// ─── Flow Definition ───────────────────────────────────────────────

export const info_comment_force_refresh: Flow<
  typeof info_comment_force_refresh_input,
  typeof info_comment_force_refresh_output
> = {
  name: "info_comment_force_refresh",
  description:
    "Force refresh the main bot info comment — invalidates all section input hashes " +
    "and report caches, then re-collects every section from scratch. " +
    "This is a true recompute: no cached data from previous collections is reused. " +
    "Useful for admin-forced refresh or when caches may be stale.",
  input: info_comment_force_refresh_input,
  output: info_comment_force_refresh_output,
  meta: {
    tags: ["info-comment", "pr", "repository_write", "admin"],
    risk: "repository_write",
    effects: ["github_comment_write", "github_read", "storage_write"],
    timeoutMs: 120_000,
    retry: { maxAttempts: 2, backoffMs: 5000 },
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:force:${input.requestedBy}`,
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof info_comment_force_refresh_input>,
  ): Promise<Static<typeof info_comment_force_refresh_output>> {
    const { prNumber, headSha } = input;

    // Validate head SHA and get base SHA
    const snapshot = await loadPrSnapshot(ctx, { prNumber, expectedHeadSha: headSha });
    const baseSha = snapshot.base.sha;

    const result = await refreshInfoComment(ctx, {
      prNumber,
      headSha,
      baseSha,
      sections: ["mods", "artifacts", "checks", "translationDiff"],
      forceInvalidate: true,
      writePreview: false,
      reason: "force_refresh",
    });

    return {
      commentId: result.commentId,
      revision: result.revision,
      invalidatedSections: ["mods", "artifacts", "checks", "translationDiff"],
      sectionStates: result.sectionStates,
      oversized: result.oversized,
      gistUrl: result.gistUrl,
    };
  },
};
