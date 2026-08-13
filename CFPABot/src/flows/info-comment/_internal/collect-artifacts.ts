// src/flows/info-comment/_internal/collect-artifacts.ts
// Collector: PR Packer workflow run and artifact status.
// Returns SectionResult<ArtifactsData> — read-only, never approves workflows.

import type { FlowContext } from "@/types.js";
import type { SectionResult, ArtifactsData } from "../../_shared/types.js";
import type { WorkflowRun, Artifact } from "@/client/github/types.js";
import { hashInputs } from "../state.js";
import { PR_PACKER_NAME } from "@/client/github/helpers.js";

/**
 * Pure: map a WorkflowRun's status/conclusion to ArtifactsData.
 * No I/O — the caller fetches artifacts and further disambiguates on success.
 */
function mapRunToStatus(run: WorkflowRun): ArtifactsData {
  if (run.status === "queued" || run.status === "in_progress" || run.status === "requested" || run.status === "pending") {
    return { state: "running", workflowRunId: run.id };
  }

  if (run.status === "waiting") {
    return { state: "waiting", workflowRunId: run.id };
  }

  if (run.status !== "completed") {
    return { state: "waiting", workflowRunId: run.id };
  }

  // Completed — check conclusion
  if (run.conclusion === "action_required") {
    return { state: "approval_required", workflowRunId: run.id };
  }

  if (run.conclusion !== "success") {
    return { state: "failed", workflowRunId: run.id, message: `Workflow ${run.conclusion}` };
  }

  // Completed with success — caller fetches artifacts
  return { state: "completed", workflowRunId: run.id };
}

/**
 * Collect PR Packer artifacts status.
 *
 * Priority (first match wins):
 * 1. Target branch not main → branch_not_supported
 * 2. PR closed → pr_closed
 * 3. Workflow run query API error → SectionResult error (WORKFLOW_RUN_QUERY_FAILED)
 * 4. Specific workflowRunId not found in head SHA results → waiting (safe)
 * 5. No workflow run found at all → waiting
 * 6. Run in progress → running
 * 7. Completed with artifacts → completed
 * 8. Completed without artifacts → no_artifacts
 * 9. Artifact fetch API error → SectionResult error (ARTIFACT_FETCH_FAILED)
 * 10. Run conclusion non-success (failure/cancelled/...) → failed
 *
 * When workflowRunId is provided (from workflow_run.completed webhook),
 * validates it belongs to the expected head SHA via findWorkflowRunsByHeadSha.
 * Returns waiting (never fallback to another run) when not found, to avoid
 * displaying artifacts from an unrelated run.
 * When omitted (full info_comment_refresh), auto-discovers the latest
 * PR Packer run for the head SHA.
 */
export async function collectArtifacts(
  ctx: FlowContext,
  prNumber: number,
  headSha: string,
  workflowRunId?: number,
): Promise<SectionResult<ArtifactsData>> {
  const inputHash = hashInputs(String(prNumber), headSha, workflowRunId != null ? String(workflowRunId) : "");

  try {
    // Get PR to check target branch and state
    const pr = await ctx.github.getPullRequest(prNumber);

    // 1. Target branch check
    if (pr.base.ref !== ctx.repo.defaultBranch) {
      return {
        status: "ready",
        data: { state: "branch_not_supported" },
        inputHash,
      };
    }

    // 2. PR closed
    if (pr.state === "closed") {
      return {
        status: "ready",
        data: { state: "pr_closed" },
        inputHash,
      };
    }

    // 3. Find workflow runs for this head SHA (PR Packer only)
    let runs: WorkflowRun[];
    try {
      runs = await ctx.github.findWorkflowRunsByHeadSha(headSha, PR_PACKER_NAME);
    } catch (err) {
      ctx.logger.warn({ err, source: "collectArtifacts", prNumber, headSha }, "Failed to query workflow runs for PR");
      return {
        status: "error",
        error: {
          code: "WORKFLOW_RUN_QUERY_FAILED",
          publicMessage: `无法查询 PR #${prNumber} 的工作流运行状态`,
          retryable: true,
        },
        inputHash,
      };
    }

    // 4. Identify the relevant run
    let run: WorkflowRun | undefined;
    if (workflowRunId != null) {
      run = runs.find(r => r.id === workflowRunId);
      // When a specific run is requested but not found, return waiting
      // instead of silently showing a different run's artifacts.
      if (!run) {
        return {
          status: "ready",
          data: { state: "waiting" },
          inputHash,
        };
      }
    } else {
      run = runs[0];
    }

    if (!run) {
      return {
        status: "ready",
        data: { state: "waiting" },
        inputHash,
      };
    }

    // 5. Map run status (pure, no I/O)
    const base = mapRunToStatus(run);

    // 6. Only completed+success needs artifact fetching
    if (base.state !== "completed") {
      return { status: "ready", data: base, inputHash };
    }

    let artifacts: Artifact[];
    try {
      artifacts = await ctx.github.getArtifactsFromWorkflow(run.id);
    } catch (err) {
      ctx.logger.warn({ err, source: "collectArtifacts", runId: run.id }, "Failed to fetch artifacts for workflow run");
      return {
        status: "error",
        error: {
          code: "ARTIFACT_FETCH_FAILED",
          publicMessage: `获取 PR #${prNumber} 的构建产物失败`,
          retryable: true,
        },
        inputHash,
      };
    }

    if (artifacts.length === 0) {
      return { status: "ready", data: { ...base, state: "no_artifacts" }, inputHash };
    }

    return {
      status: "ready",
      data: {
        ...base,
        artifacts: artifacts.map(a => ({
          name: a.name,
          downloadUrl: a.archive_download_url,
        })),
      },
      inputHash,
    };
  } catch (err) {
    ctx.logger.warn({ err, source: "collectArtifacts" }, "Unexpected error collecting artifacts");
    return {
      status: "error",
      error: {
        code: "ARTIFACT_COLLECT_FAILED",
        publicMessage: `无法获取 PR #${prNumber} 的构建状态`,
        retryable: true,
      },
      inputHash,
    };
  }
}
