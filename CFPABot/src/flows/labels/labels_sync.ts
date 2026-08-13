// src/flows/labels/labels_sync.ts
// Flow: labels_sync — compute expected managed labels from PR change size and
//   changed paths, then sync them (add missing, remove stale managed labels).
//   Never removes manual or other-automation labels — only the MANAGED_LABELS set.
// Risk: repository_write | Effects: github_read, github_metadata_write
//
// Spec: docs/specs/02-flow-catalog.md §6 + docs/specs/06-automation-and-mutations.md §3

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { loadPrSnapshot, loadPrDiff } from "../_internal/index.js";
import { MANAGED_LABELS, SIZE_LABEL_BUCKETS, PATH_LABEL_MAP } from "@/config.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const labels_sync_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA for staleness check" }),
});

export type LabelsSyncInput = Static<typeof labels_sync_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const labels_sync_output = Type.Object({
  added: Type.Array(Type.String(), { description: "Managed labels that were added" }),
  removed: Type.Array(Type.String(), { description: "Managed labels that were removed (no longer expected)" }),
  unchanged: Type.Array(Type.String(), { description: "Managed labels that were already correct" }),
});

export type LabelsSyncOutput = Static<typeof labels_sync_output>;

// ─── Idempotency key ───────────────────────────────────────────────────

function idempotencyKey(
  invocation: { id: string; source: string; deliveryId?: string },
  input: Static<typeof labels_sync_input>,
): string {
  const prefix = invocation.deliveryId ?? invocation.id;
  return `${prefix}|labels_sync|${input.prNumber}|${input.headSha}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Compute the size label for a given total change count. */
function computeSizeLabel(totalChanges: number): string | null {
  for (const bucket of SIZE_LABEL_BUCKETS) {
    if (totalChanges >= bucket.min && totalChanges <= bucket.max) {
      return bucket.label;
    }
  }
  return null;
}

/** Compute path labels from changed file paths. */
function computePathLabels(changedFiles: Array<{ filename: string }>): string[] {
  const result = new Set<string>();
  for (const file of changedFiles) {
    for (const [prefix, label] of Object.entries(PATH_LABEL_MAP)) {
      if (file.filename.startsWith(prefix)) {
        result.add(label);
      }
    }
  }
  return [...result].sort();
}

// ─── Flow Definition ───────────────────────────────────────────────────

export const labels_sync: Flow<typeof labels_sync_input, typeof labels_sync_output> = {
  name: "labels_sync",
  description:
    "Compute expected managed labels based on PR change size and changed file paths, " +
    "then synchronise them with the PR's current labels. " +
    "Only mutates labels in the configured MANAGED_LABELS set — manual and other-automation labels are preserved.",
  input: labels_sync_input,
  output: labels_sync_output,
  meta: {
    tags: ["pr", "labels"],
    risk: "repository_write",
    effects: ["github_read", "github_metadata_write"],
    idempotencyKey,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof labels_sync_input>,
  ): Promise<Static<typeof labels_sync_output>> {
    const { prNumber, headSha } = input;

    // 1. Load PR snapshot and diff in parallel
    const [snapshot, diff] = await Promise.all([
      loadPrSnapshot(ctx, { prNumber, expectedHeadSha: headSha }),
      loadPrDiff(ctx, { prNumber, expectedHeadSha: headSha }),
    ]);

    // 2. Compute expected managed labels
    const totalChanges = diff.files.reduce((acc, f) => acc + f.changes, 0);
    const sizeLabel = computeSizeLabel(totalChanges);
    const pathLabels = computePathLabels(diff.files);

    const expected: string[] = [];
    if (sizeLabel) expected.push(sizeLabel);
    expected.push(...pathLabels);

    const expectedSet = new Set(expected);

    // 3. Separate current labels into managed vs non-managed
    const currentLabels = snapshot.labels;
    const currentManaged = currentLabels.filter((l) => MANAGED_LABELS.has(l));
    const currentNonManaged = currentLabels.filter((l) => !MANAGED_LABELS.has(l));

    // 4. Compute diff within managed set
    const currentManagedSet = new Set(currentManaged);
    const toAdd = expected.filter((l) => !currentManagedSet.has(l));
    const toRemove = currentManaged.filter((l) => !expectedSet.has(l));
    const unchanged = currentManaged.filter((l) => expectedSet.has(l));

    // 5. If nothing to change, return early (zero GitHub writes)
    if (toAdd.length === 0 && toRemove.length === 0) {
      ctx.logger.info({ prNumber, headSha }, "labels_sync: no label changes needed");
      return { added: [], removed: [], unchanged };
    }

    // 6. Apply changes via GitHub
    try {
      // Use syncLabels with the full desired set (managed + non-managed) to avoid
      // touching non-managed labels. GitHub's syncLabels adds desired labels and
      // removes any current label not in the desired set.
      const desired = [...currentNonManaged, ...expected];
      await ctx.github.syncLabels(prNumber, desired, currentLabels);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ prNumber, err: message }, "labels_sync: failed to sync labels");
      throw new FlowError({
        code: "FAILED",
        message,
        publicMessage: "Failed to synchronise labels on GitHub.",
        retryable: true,
      });
    }

    ctx.logger.info(
      { prNumber, added: toAdd, removed: toRemove, unchangedCount: unchanged.length },
      "labels_sync: labels updated",
    );

    return { added: toAdd, removed: toRemove, unchanged };
  },
};
