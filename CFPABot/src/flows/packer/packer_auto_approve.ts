// src/flows/packer/packer_auto_approve.ts
// Flow: packer_auto_approve — auto-approve a PR Packer workflow run when all
//   safety conditions are met.
// Risk: repository_write | Effects: github_read, github_workflow_write
//
// Spec: docs/specs/02-flow-catalog.md §6 + docs/specs/06-automation-and-mutations.md §5
// Only this Flow may approve a PR Packer workflow — artifact collectors and
// info_comment_refresh must NOT approve workflows.
// Idempotency per workflow run attempt.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { loadPrSnapshot, loadPrDiff } from "../_internal/index.js";
import { REPO } from "@/config.js";
import type { WorkflowRun } from "@/client/github/types.js";

// ─── Constants ─────────────────────────────────────────────────────────

export const PACKER_WORKFLOW_NAME = "PR Packer";

// ─── Input Schema ──────────────────────────────────────────────────────

export const packer_auto_approve_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA for staleness check" }),
  workflowRunId: Type.Optional(
    Type.Number({
      description:
        "Specific workflow run ID to approve. " +
        "When omitted the flow auto-discovers the latest PR Packer run " +
        "for headSha via findWorkflowRunsByHeadSha. " +
        "If auto-discovery finds no matching run the flow safely returns skipped.",
    }),
  ),
});

export type PackerAutoApproveInput = Static<typeof packer_auto_approve_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const packer_auto_approve_output = Type.Object({
  action: Type.Union([Type.Literal("approved"), Type.Literal("skipped")], {
    description: "Whether the workflow run was approved or skipped",
  }),
  reason: Type.String({ description: "Human-readable explanation of the decision" }),
});

export type PackerAutoApproveOutput = Static<typeof packer_auto_approve_output>;

// ─── Idempotency key ───────────────────────────────────────────────────

function idempotencyKey(
  invocation: { id: string; source: string; deliveryId?: string },
  input: Static<typeof packer_auto_approve_input>,
): string {
  // Per workflow-run-attempt: when runId is known key on it directly;
  // fall back to prNumber+headSha for webhook re-delivery before a run exists.
  const runPart = input.workflowRunId ? `run-${input.workflowRunId}` : `head-${input.headSha}`;
  const prefix = invocation.deliveryId ?? invocation.id;
  return `${prefix}|packer_auto_approve|${input.prNumber}|${runPart}`;
}

// ─── Safety check helpers ──────────────────────────────────────────────

/** Returns { ok: true } or { ok: false, reason } when a safety condition fails. */
type SafetyResult = { ok: true } | { ok: false; reason: string };

function notOk(reason: string): SafetyResult {
  return { ok: false, reason };
}

// ─── Flow Definition ───────────────────────────────────────────────────

export const packer_auto_approve: Flow<
  typeof packer_auto_approve_input,
  typeof packer_auto_approve_output
> = {
  name: "packer_auto_approve",
  description:
    "Auto-approve the PR Packer workflow for a PR when all safety conditions are met. " +
    "Conditions: workflow exists and requires action, PR is open, target is main branch, " +
    "no changes to .github/ or src/ directories. " +
    "Returns 'skipped' with a reason when any condition fails — never throws for safe skips.",
  input: packer_auto_approve_input,
  output: packer_auto_approve_output,
  meta: {
    tags: ["pr", "packer", "workflow"],
    risk: "repository_write",
    effects: ["github_read", "github_workflow_write"],
    idempotencyKey,
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof packer_auto_approve_input>,
  ): Promise<Static<typeof packer_auto_approve_output>> {
    const { prNumber, headSha, workflowRunId } = input;

    // ── 1. PR-level safety checks (no workflow run needed) ──────────
    const [snapshot, diff] = await Promise.all([
      loadPrSnapshot(ctx, { prNumber, expectedHeadSha: headSha }),
      loadPrDiff(ctx, { prNumber, expectedHeadSha: headSha }),
    ]);

    // 1a. Target branch must be main
    if (snapshot.base.ref !== REPO.DEFAULT_BRANCH) {
      const reason = `Target branch is "${snapshot.base.ref}", not "${REPO.DEFAULT_BRANCH}"`;
      ctx.logger.info({ prNumber, headSha, reason }, "packer_auto_approve: skipped");
      return { action: "skipped", reason };
    }

    // 1b. PR must be open
    if (snapshot.state !== "open") {
      const reason = `PR is ${snapshot.state}, not open`;
      ctx.logger.info({ prNumber, headSha, reason }, "packer_auto_approve: skipped");
      return { action: "skipped", reason };
    }

    // 1c. Must not change .github/ or src/
    const blockedPath = diff.files.find(
      (f) => f.filename.startsWith(".github/") || f.filename.startsWith("src/"),
    );
    if (blockedPath) {
      const reason = `Changed path "${blockedPath.filename}" is in a protected directory (.github/ or src/)`;
      ctx.logger.info({ prNumber, headSha, reason }, "packer_auto_approve: skipped");
      return { action: "skipped", reason };
    }

    // ── 2. Discover or resolve workflow run ────────────────────────
    let resolvedRunId: number;

    if (workflowRunId !== undefined) {
      resolvedRunId = workflowRunId;
    } else {
      // Auto-discover the latest PR Packer run for this head SHA
      let runs: WorkflowRun[];
      try {
        runs = await ctx.github.findWorkflowRunsByHeadSha(headSha, PACKER_WORKFLOW_NAME);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn({ prNumber, headSha, err: message }, "packer_auto_approve: failed to list workflow runs");
        return { action: "skipped", reason: `Failed to list workflow runs: ${message}` };
      }

      if (runs.length === 0) {
        const reason = `No "${PACKER_WORKFLOW_NAME}" workflow runs found for head SHA ${headSha.slice(0, 7)}`;
        ctx.logger.info({ prNumber, headSha, reason }, "packer_auto_approve: skipped");
        return { action: "skipped", reason };
      }

      // Pick the newest run (runs are sorted newest-first by the client)
      resolvedRunId = runs[0]!.id;

      ctx.logger.info(
        { prNumber, headSha, totalRuns: runs.length, selected: resolvedRunId },
        "packer_auto_approve: discovered workflow run",
      );
    }

    // ── 3. Fetch workflow run ──────────────────────────────────────
    let workflowRun: WorkflowRun;
    try {
      workflowRun = await ctx.github.getWorkflowRun(resolvedRunId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn({ prNumber, runId: resolvedRunId, err: message }, "packer_auto_approve: workflow run not found");
      return {
        action: "skipped",
        reason: `Workflow run #${resolvedRunId} not found or inaccessible: ${message}`,
      };
    }

    // 3a. Workflow name must match
    const actualName = workflowRun.name ?? "";
    if (!actualName.includes(PACKER_WORKFLOW_NAME)) {
      const reason = `Workflow run name "${actualName}" does not contain "${PACKER_WORKFLOW_NAME}"`;
      ctx.logger.info({ prNumber, resolvedRunId, reason }, "packer_auto_approve: skipped");
      return { action: "skipped", reason };
    }

    // 3b. Status must be action_required
    if (workflowRun.status !== "action_required") {
      const reason = `Workflow run status is "${workflowRun.status}", not "action_required"`;
      ctx.logger.info({ prNumber, resolvedRunId, reason }, "packer_auto_approve: skipped");
      return { action: "skipped", reason };
    }

    // ── 4. Approve ──────────────────────────────────────────────────
    try {
      await ctx.github.approveWorkflowRun(resolvedRunId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ prNumber, runId: resolvedRunId, err: message }, "packer_auto_approve: approval failed");
      throw new FlowError({
        code: "FAILED",
        message,
        publicMessage: `Failed to approve workflow run #${resolvedRunId}.`,
        retryable: true,
      });
    }

    ctx.logger.info({ prNumber, headSha, runId: resolvedRunId }, "packer_auto_approve: approved");
    return { action: "approved", reason: `Workflow run #${resolvedRunId} has been approved.` };
  },
};
