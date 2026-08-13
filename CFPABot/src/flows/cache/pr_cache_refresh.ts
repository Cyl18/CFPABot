// src/flows/cache/pr_cache_refresh.ts
// Flow: pr_cache_refresh — orchestrates PR cache refresh from GitHub data.
// Risk: repository_write | Effects: storage_write
// Concrete Flow wrapper that owns the refresh orchestration decisions
// (incremental vs full, watermark advance, prIndex + relation coordination).
// Single-PR operations and disk caching are delegated to the client layer
// (src/client/pr-relations-cache.ts).
// Called by webhook, cron, and admin operations.
//
// Spec: docs/specs/02-flow-catalog.md §6
import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import {
  refreshPrListCache,
  refreshSinglePrCache,
  removeClosedFromPrCache,
} from "../_internal/refresh-pr-cache.js";

// ─── Input Schema ──────────────────────────────────────────────────────
export const pr_cache_refresh_input = Type.Object({
  prNumber: Type.Optional(
    Type.Number({ description: "PR number; required when mode is 'one' or 'remove_closed'" }),
  ),
  mode: Type.Union(
    [
      Type.Literal("one"),
      Type.Literal("all"),
      Type.Literal("remove_closed"),
    ],
    { description: "Scope of the refresh operation" },
  ),
  force: Type.Optional(
    Type.Boolean({ description: "Force full refresh (mode 'all' only); bypasses watermark skip" }),
  ),
});

export type PrCacheRefreshInput = Static<typeof pr_cache_refresh_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const pr_cache_refresh_output = Type.Object({
  refreshed: Type.Number({ description: "Number of PRs/cache entries refreshed" }),
  removed: Type.Number({ description: "Number of PRs/cache entries removed" }),
  failed: Type.Number({ description: "Number of operations that failed" }),
});

export type PrCacheRefreshOutput = Static<typeof pr_cache_refresh_output>;

// ─── Idempotency key ───────────────────────────────────────────────────

function idempotencyKey(
  invocation: { id: string; source: string; deliveryId?: string },
  input: Static<typeof pr_cache_refresh_input>,
): string {
  const prefix = invocation.deliveryId ?? invocation.id;
  const target = input.prNumber ? `pr-${input.prNumber}` : "all";
  return `${prefix}|pr_cache_refresh|${input.mode}|${target}`;
}

// ─── Flow Definition ───────────────────────────────────────────────────

export const pr_cache_refresh: Flow<typeof pr_cache_refresh_input, typeof pr_cache_refresh_output> = {
  name: "pr_cache_refresh",
  description:
    "Refresh the PR list cache and PR relation cache. " +
    "Mode 'all' refreshes all open PRs. Mode 'one' refreshes a single PR (prNumber required). " +
    "Mode 'remove_closed' removes a closed PR from the local cache (prNumber required). " +
    "Only writes to local storage — does not modify GitHub.",
  input: pr_cache_refresh_input,
  output: pr_cache_refresh_output,
  meta: {
    tags: ["pr", "cache"],
    risk: "repository_write",
    effects: ["storage_write"],
    idempotencyKey,
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof pr_cache_refresh_input>,
  ): Promise<Static<typeof pr_cache_refresh_output>> {
    const { prNumber, mode } = input;

    switch (mode) {
      case "all": {
        const result = await refreshPrListCache(ctx, undefined, input.force);
        return { refreshed: result.refreshed, removed: result.removed, failed: result.failed };
      }

      case "one": {
        if (!prNumber) {
          throw new FlowError({
            code: "INVALID_INPUT",
            message: "prNumber is required when mode is 'one'",
            publicMessage: "Please specify a PR number.",
            retryable: false,
          });
        }
        const result = await refreshSinglePrCache(ctx, prNumber);
        return { refreshed: result.refreshed, removed: result.removed, failed: result.failed };
      }

      case "remove_closed": {
        if (!prNumber) {
          throw new FlowError({
            code: "INVALID_INPUT",
            message: "prNumber is required when mode is 'remove_closed'",
            publicMessage: "Please specify a PR number.",
            retryable: false,
          });
        }
        const result = await removeClosedFromPrCache(ctx, prNumber);
        return { refreshed: result.refreshed, removed: result.removed, failed: result.failed };
      }

      default: {
        // Exhaustiveness check
        const _exhaustive: never = mode;
        throw new FlowError({
          code: "INVALID_INPUT",
          message: `Unknown mode: ${_exhaustive}`,
          publicMessage: `Unknown mode "${_exhaustive}".`,
          retryable: false,
        });
      }
    }
  },
};
