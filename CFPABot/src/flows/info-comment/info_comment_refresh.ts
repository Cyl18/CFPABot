// src/flows/info-comment/info_comment_refresh.ts
// Flow: info_comment_refresh — full info comment refresh.
// Risk: repository_write | Effects: github_comment_write, github_read, storage_write
// Used for PR opened, synchronize, and manual admin refresh.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { refreshInfoComment } from "./_internal/index.js";
import { loadPrSnapshot } from "../_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────

export const info_comment_refresh_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA — fails STALE_HEAD if mismatch" }),
  reason: Type.Union(
    [Type.Literal("opened"), Type.Literal("synchronize"), Type.Literal("manual")],
    { description: "Why this refresh was triggered" },
  ),
});

export type InfoCommentRefreshInput = Static<typeof info_comment_refresh_input>;

// ─── Output DTO ────────────────────────────────────────────────────

export const info_comment_refresh_output = Type.Object({
  commentId: Type.Number({ description: "GitHub comment ID" }),
  revision: Type.Number({ description: "State revision after this refresh" }),
  sectionStates: Type.Record(
    Type.String(),
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("ready"),
      Type.Literal("empty"),
      Type.Literal("error"),
    ]),
    { description: "Status of each section" },
  ),
  oversized: Type.Boolean({ description: "True if the comment exceeded GitHub size limit and used Gist fallback" }),
  gistUrl: Type.Optional(Type.String({ description: "URL to Gist if oversized fallback was used" })),
});

export type InfoCommentRefreshOutput = Static<typeof info_comment_refresh_output>;

// ─── Flow Definition ───────────────────────────────────────────────

export const info_comment_refresh: Flow<
  typeof info_comment_refresh_input,
  typeof info_comment_refresh_output
> = {
  name: "info_comment_refresh",
  description:
    "Full refresh of the main bot info comment on a PR. " +
    "Collects mod links, PR Packer artifacts, deterministic checks, and translation diff. " +
    "Creates the <!--CYBOT--> comment if it doesn't exist. " +
    "Uses process lock and revision check for concurrency safety. " +
    "Section failures are independent — one failed section doesn't block others. " +
    "Does not approve workflows or add labels.",
  input: info_comment_refresh_input,
  output: info_comment_refresh_output,
  meta: {
    tags: ["info-comment", "pr", "repository_write"],
    risk: "repository_write",
    effects: ["github_comment_write", "github_read", "storage_write"],
    timeoutMs: 120_000,
    retry: { maxAttempts: 2, backoffMs: 5000 },
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:${input.reason}`,
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof info_comment_refresh_input>,
  ): Promise<Static<typeof info_comment_refresh_output>> {
    const { prNumber, headSha, reason } = input;

    // Load PR snapshot to validate head SHA and get base SHA for diff
    const snapshot = await loadPrSnapshot(ctx, { prNumber, expectedHeadSha: headSha });
    const baseSha = snapshot.base.sha;

    const result = await refreshInfoComment(ctx, {
      prNumber,
      headSha,
      baseSha,
      sections: ["mods", "artifacts", "checks", "translationDiff"],
      writePreview: true,
      reason,
    });

    return {
      commentId: result.commentId,
      revision: result.revision,
      sectionStates: result.sectionStates,
      oversized: result.oversized,
      gistUrl: result.gistUrl,
    };
  },
};
