// src/flows/checks/checks_run_label_guard.ts
// Flow: checks_run_label_guard — create/update the "CFPABot / Label Guard" Check Run
//   for a PR, checking whether any configured blocked/forbidden labels are present.
// Risk: repository_write | Effects: github_read, github_check_write
//
// Spec: docs/specs/02-flow-catalog.md §6 + docs/specs/06-automation-and-mutations.md §2
// Uses loadPrSnapshot() internal to fetch PR and obtain labels.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { loadPrSnapshot } from "../_internal/index.js";
import { FORBIDDEN_LABELS } from "@/config.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const checks_run_label_guard_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA for staleness check" }),
});

export type ChecksRunLabelGuardInput = Static<typeof checks_run_label_guard_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const checks_run_label_guard_output = Type.Object({
  conclusion: Type.Union([Type.Literal("success"), Type.Literal("failure")], {
    description: "Check Run conclusion: success (no blocked labels) or failure (blocked labels found)",
  }),
  blockedLabels: Type.Array(Type.String(), { description: "Labels that matched the forbidden set; empty on success" }),
});

export type ChecksRunLabelGuardOutput = Static<typeof checks_run_label_guard_output>;

// ─── Check Run name (canonical) ────────────────────────────────────────

export const LABEL_GUARD_CHECK_RUN_NAME = "CFPABot / Label Guard";

// ─── Idempotency key ───────────────────────────────────────────────────

function idempotencyKey(
  invocation: { id: string; source: string; deliveryId?: string },
  input: Static<typeof checks_run_label_guard_input>,
): string {
  // Webhook: deliveryId + prNumber + headSha → same delivery same head produces one Check Run.
  // Agent: same logic ensures a retry on the same target does not re-create.
  const prefix = invocation.deliveryId ?? invocation.id;
  return `${prefix}|checks_run_label_guard|${input.prNumber}|${input.headSha}`;
}

// ─── Flow Definition ───────────────────────────────────────────────────

export const checks_run_label_guard: Flow<
  typeof checks_run_label_guard_input,
  typeof checks_run_label_guard_output
> = {
  name: "checks_run_label_guard",
  description:
    "Create or update the 'CFPABot / Label Guard' Check Run for a PR. " +
    "If the PR carries any configured blocked/forbidden labels the Check Run is set to 'failure' " +
    "and the offending labels are listed; otherwise it is 'success'. " +
    "Does not add or remove any labels.",
  input: checks_run_label_guard_input,
  output: checks_run_label_guard_output,
  meta: {
    tags: ["pr", "checks"],
    risk: "repository_write",
    effects: ["github_read", "github_check_write"],
    idempotencyKey,
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof checks_run_label_guard_input>,
  ): Promise<Static<typeof checks_run_label_guard_output>> {
    const { prNumber, headSha } = input;

    // 1. Load PR snapshot — validates head SHA staleness
    const snapshot = await loadPrSnapshot(ctx, { prNumber, expectedHeadSha: headSha });

    // 2. Match current labels against the forbidden set
    const currentLabels = snapshot.labels;
    const blocked = currentLabels.filter((l) => FORBIDDEN_LABELS.has(l));

    const conclusion = blocked.length === 0 ? "success" as const : "failure" as const;
    const summary =
      blocked.length === 0
        ? "No blocked labels found — PR is clear to merge."
        : `Blocked labels found: ${blocked.join(", ")}`;
    const text =
      blocked.length === 0
        ? "All good! No forbidden labels are set on this PR."
        : `The following label(s) are blocking this PR from being merged:\n\n${blocked.map((l) => `- ${l}`).join("\n")}`;

    // 3. Create or update the Check Run bound to headSha
    try {
      await ctx.github.createCheckRun({
        name: LABEL_GUARD_CHECK_RUN_NAME,
        sha: headSha,
        status: "completed",
        conclusion,
        output: {
          title: blocked.length === 0 ? "No blocked labels" : "Blocked labels detected",
          summary,
          text,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ prNumber, headSha, err: message }, "checks_run_label_guard: failed to create Check Run");
      throw new FlowError({
        code: "FAILED",
        message,
        publicMessage: "Failed to create or update the Label Guard Check Run on GitHub.",
        retryable: true,
      });
    }

    ctx.logger.info(
      { prNumber, headSha, conclusion, blockedCount: blocked.length },
      "checks_run_label_guard: Check Run created",
    );

    return { conclusion, blockedLabels: blocked };
  },
};
