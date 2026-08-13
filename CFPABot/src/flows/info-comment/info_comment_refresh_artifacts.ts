import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { refreshInfoComment } from "./_internal/index.js";
import { loadInfoCommentState } from "./state.js";
import { loadPrSnapshot } from "../_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────

export const info_comment_refresh_artifacts_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  workflowRunId: Type.Number({ description: "Workflow run ID that triggered this refresh" }),
  headSha: Type.String({ description: "Expected head SHA — fails STALE_HEAD if mismatch" }),
});

export type InfoCommentRefreshArtifactsInput = Static<typeof info_comment_refresh_artifacts_input>;

// ─── Output DTO ────────────────────────────────────────────────────

export const info_comment_refresh_artifacts_output = Type.Object({
  commentId: Type.Number({ description: "GitHub comment ID" }),
  revision: Type.Number({ description: "State revision after refresh" }),
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
});

export type InfoCommentRefreshArtifactsOutput = Static<typeof info_comment_refresh_artifacts_output>;

// ─── Flow Definition ───────────────────────────────────────────────

export const info_comment_refresh_artifacts: Flow<
  typeof info_comment_refresh_artifacts_input,
  typeof info_comment_refresh_artifacts_output
> = {
  name: "info_comment_refresh_artifacts",
  description:
    "Refresh only the artifacts section of the main bot info comment. " +
    "Other sections retain their typed state data. " +
    "If no existing state is found, initializes with all sections pending " +
    "except artifacts. Never calls the full refresh. " +
    "Does not approve workflows.",
  input: info_comment_refresh_artifacts_input,
  output: info_comment_refresh_artifacts_output,
  meta: {
    tags: ["info-comment", "pr", "repository_write"],
    risk: "repository_write",
    effects: ["github_comment_write", "github_read", "storage_write"],
    timeoutMs: 60_000,
    retry: { maxAttempts: 2, backoffMs: 5000 },
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.workflowRunId}:${input.headSha}`,
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof info_comment_refresh_artifacts_input>,
  ): Promise<Static<typeof info_comment_refresh_artifacts_output>> {
    const { prNumber, workflowRunId, headSha } = input;

    // Validate head SHA
    await loadPrSnapshot(ctx, { prNumber, expectedHeadSha: headSha });

    // Load existing state
    const existingState = await loadInfoCommentState(
      ctx.store, ctx.repo.owner, ctx.repo.name, prNumber,
    );

    if (!existingState) {
      // No existing state — initialize all sections as pending except artifacts.
      // Use the full refresh flow with only artifacts section to avoid
      // duplicating the initialization logic. This is the one case where
      // refreshInfoComment is called with a single section.
      const result = await refreshInfoComment(ctx, {
        prNumber,
        headSha,
        workflowRunId,
        sections: ["artifacts"],
        writePreview: false,
        reason: "workflow_run",
      });

      return {
        commentId: result.commentId,
        revision: result.revision,
        sectionStates: result.sectionStates,
      };
    }

    const result = await refreshInfoComment(ctx, {
      prNumber,
      headSha,
      workflowRunId,
      sections: ["artifacts"],
      writePreview: false,
      reason: "workflow_run",
    });

    return {
      commentId: result.commentId,
      revision: result.revision,
      sectionStates: result.sectionStates,
    };
  },
};
