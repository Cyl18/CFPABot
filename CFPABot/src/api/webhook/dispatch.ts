// src/api/webhook/dispatch.ts
// Central event router — maps event types to programmatic Flow executions.
// The dispatcher's only job is routing on a ready-made WebhookDto.
// No raw payload, no eventToDto call, no client side-effects.
// Flow orchestration and business logic are delegated to the Flow layer.

import type { FlowRegistry } from "@/engine/registry.js";
import { buildContext, type EntryDependencies } from "@/context.js";
import { executeFlow } from "@/engine/execute.js";
import type { WebhookDto } from "./dto.js";
import { hasRefreshCheckbox } from "./receiver.js";
import { PR_PACKER_NAME } from "@/client/github/helpers.js";
import { invalidatePrCache } from "@/api/frontend/pr.js";
import { invalidateCompareSourcesCache } from "@/api/frontend/compare.js";

type ExecutorFn = (
  flowName: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Route a webhook DTO to its corresponding programmatic Flow(s).
 * Accepts a pre-built WebhookDto only — no raw payload leaks here.
 * Builds a single invocation context per delivery; sequential and parallel
 * execution orders are expressed explicitly.
 * Dispatch never calls eventToDto, never reads a raw payload, and never
 * performs direct client/business side effects (仅失效前端路由的内存缓存,
 * 不触发任何外部调用).
 */
export async function dispatch(
  dto: WebhookDto,
  deps: EntryDependencies,
  registry: FlowRegistry,
): Promise<void> {
  const parentInvocationId = crypto.randomUUID();

  // Build scope from DTO using type discriminator
  const scope: { prNumber?: number; baseSha?: string; headSha?: string } = (() => {
    switch (dto.type) {
      case "pull_request.opened":
      case "pull_request.synchronize":
      case "pull_request.edited":
      case "pull_request.labeled":
      case "pull_request.unlabeled":
        return { prNumber: dto.prNumber, baseSha: dto.baseSha, headSha: dto.headSha };
      case "pull_request.closed":
      case "issue_comment.created":
        return { prNumber: dto.prNumber };
      case "issue_comment.edited":
        return { prNumber: dto.prNumber, headSha: dto.headSha };
      case "workflow_run.completed":
        return { prNumber: dto.prNumber, headSha: dto.headSha };
      case "push":
        return {};
    }
  })();

  // Build FlowContext — webhook uses a detached (never-aborted) signal
  const ctx = buildContext(
    { type: dto.type, source: "webhook", payload: null },
    deps,
    {
      actor: { kind: "system" },
      scope,
      invocation: {
        // Deterministic per-delivery id: GitHub redelivers failed webhooks
        // (exponential backoff, hours) and may replay manually — a random id
        // per delivery would bypass the persisted idempotency cache and
        // re-execute side-effect flows (duplicate pushes/comments). Flows
        // embed invocation.id in their idempotency keys, so a stable id makes
        // redelivery hit the cache. No deliveryId (manual trigger) → random.
        id: dto.deliveryId ?? crypto.randomUUID(),
        source: "webhook",
        parentId: parentInvocationId,
        deliveryId: dto.deliveryId,
      },
      signal: new AbortController().signal,
    },
  );

  // Create a bound executor for this context and registry
  const exec: ExecutorFn = (flowName, input) => {
    const flow = registry.get(flowName);
    return executeFlow(flow, ctx, input);
  };

  switch (dto.type) {
    // ── Pull request opened / synchronize ──────────────────────────
    case "pull_request.opened":
    case "pull_request.synchronize": {
      // PR 内容变化 — 使前端路由的 PR 详情/对比源内存缓存失效
      invalidatePrCache(dto.prNumber);
      invalidateCompareSourcesCache(dto.prNumber);

      // Sequential: packer auto-approve first
      try {
        await exec("packer_auto_approve", { prNumber: dto.prNumber, headSha: dto.headSha });
      } catch (err) {
        ctx.logger.warn({ err: String(err), prNumber: dto.prNumber }, "Packer auto-approve failed");
      }

      // Parallel: info comment, label guard, labels sync, cache refresh
      const parallelTasks = [
        exec("info_comment_refresh", {
          prNumber: dto.prNumber,
          headSha: dto.headSha,
          reason: dto.type === "pull_request.opened" ? "opened" : "synchronize",
        }),
        exec("checks_run_label_guard", { prNumber: dto.prNumber, headSha: dto.headSha }),
        exec("labels_sync", { prNumber: dto.prNumber, headSha: dto.headSha }),
        exec("pr_cache_refresh", { mode: "one", prNumber: dto.prNumber }),
      ];

      const results = await Promise.allSettled(parallelTasks);
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        const logFn = failed.length === results.length ? ctx.logger.error : ctx.logger.warn;
        logFn(
          { prNumber: dto.prNumber, type: dto.type, failedCount: failed.length, totalCount: results.length, errors: failed.map((r) => String((r as PromiseRejectedResult).reason)) },
          failed.length === results.length ? "All parallel flows failed for webhook delivery" : "Some parallel flows failed for webhook delivery",
        );
      }
      break;
    }

    // ── Pull request edited ───────────────────────────────────────
    case "pull_request.edited": {
      const results = await Promise.allSettled([
        exec("checks_run_label_guard", { prNumber: dto.prNumber, headSha: dto.headSha }),
        exec("labels_sync", { prNumber: dto.prNumber, headSha: dto.headSha }),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          ctx.logger.warn({ err: String(result.reason), prNumber: dto.prNumber, type: dto.type }, "Parallel flow failed (PR edited)");
        }
      }
      break;
    }

    // ── Pull request labeled / unlabeled ──────────────────────────
    case "pull_request.labeled":
    case "pull_request.unlabeled": {
      try {
        await exec("checks_run_label_guard", { prNumber: dto.prNumber, headSha: dto.headSha });
      } catch (err) {
        ctx.logger.warn({ err: String(err), prNumber: dto.prNumber }, "Label guard failed");
      }
      break;
    }

    // ── Pull request closed ───────────────────────────────────────
    case "pull_request.closed": {
      // PR 关闭 — 内存缓存立即失效,避免前端展示过期数据
      invalidatePrCache(dto.prNumber);
      invalidateCompareSourcesCache(dto.prNumber);

      try {
        await exec("pr_cache_refresh", { mode: "remove_closed", prNumber: dto.prNumber });
      } catch (err) {
        ctx.logger.warn({ err: String(err), prNumber: dto.prNumber }, "PR cache remove-closed failed");
      }
      break;
    }

    // ── Issue comment created — /agent 命令已由 route 层处理,dispatch 无动作 ──
    case "issue_comment.created": {
      ctx.logger.debug({ prNumber: dto.prNumber }, "Unhandled issue_comment.created");
      break;
    }

    // ── Issue comment edited — refresh checkbox ────────────────────
    case "issue_comment.edited": {
      if (dto.isPrComment && hasRefreshCheckbox(dto.commentBody)) {
        try {
          await exec("info_comment_force_refresh", {
            prNumber: dto.prNumber,
            headSha: dto.headSha,
            requestedBy: "webhook",
          });
        } catch (err) {
          ctx.logger.warn({ err: String(err), prNumber: dto.prNumber }, "Info comment force refresh failed");
        }
      }
      break;
    }

    // ── Workflow run completed — PR Packer artifact refresh ────────
    case "workflow_run.completed": {
      // Only exact canonical name triggers artifact refresh
      const isPrPacker = dto.workflowName === PR_PACKER_NAME;

      if (isPrPacker && dto.prNumber) {
        ctx.logger.info(
          { prNumber: dto.prNumber, workflowName: dto.workflowName, runId: dto.workflowRunId },
          "PR Packer workflow completed — refreshing artifacts",
        );
        try {
          await exec("info_comment_refresh_artifacts", {
            prNumber: dto.prNumber,
            workflowRunId: dto.workflowRunId,
            headSha: dto.headSha,
          });
        } catch (err) {
          ctx.logger.warn({ err: String(err), prNumber: dto.prNumber, runId: dto.workflowRunId }, "Artifact refresh failed");
        }
      } else {
        ctx.logger.debug({ workflowName: dto.workflowName, prNumber: dto.prNumber }, "Non-Packer workflow run — skipping");
      }
      break;
    }

    // ── Push to default branch — refresh modlist cache ──────────
    case "push": {
      ctx.logger.info({ headSha: dto.headSha, ref: dto.ref }, "Push to default branch — 触发 modlist_refresh");
      try {
        await exec("modlist_refresh", { force: true });
      } catch (err) {
        ctx.logger.warn({ err: String(err) }, "modlist_refresh failed");
      }
      break;
    }

    default: {
      const _exhaustive: never = dto;
      ctx.logger.debug({}, "Unhandled DTO type in switch — exhaustive check");
    }
  }
}
