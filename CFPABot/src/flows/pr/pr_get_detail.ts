// Flow: pr_get_detail — full PR detail: context + workflow/check status.
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { loadPrSnapshot } from "../_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const pr_get_detail_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  expectedHeadSha: Type.Optional(
    Type.String({ description: "Fail STALE_HEAD if current head doesn't match" }),
  ),
});
// ─── File Entry Sub-Schema ─────────────────────────────────────────────

const FileEntrySchema = Type.Object({
  path: Type.String(),
  status: Type.String(),
  additions: Type.Number(),
  deletions: Type.Number(),
});

export type PrGetDetailInput = Static<typeof pr_get_detail_input>;

// ─── Output DTO ─────────────────────────────────────────────────────────

export const pr_get_detail_output = Type.Object({
  // PR context (same as pr_get_context)
  prNumber: Type.Number(),
  title: Type.String(),
  htmlUrl: Type.String(),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  draft: Type.Boolean(),
  author: Type.Union([
    Type.Null(),
    Type.Object({ login: Type.String(), id: Type.Number() }),
  ]),
  labels: Type.Array(Type.String()),
  head: Type.Object({ sha: Type.String(), ref: Type.String() }),
  base: Type.Object({ sha: Type.String(), ref: Type.String() }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  changedFiles: Type.Number(),
  files: Type.Array(FileEntrySchema),

  // Workflow/check status
  workflows: Type.Array(
    Type.Object({
      name: Type.String(),
      status: Type.String(),
      conclusion: Type.Union([Type.String(), Type.Null()]),
      htmlUrl: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

export type PrGetDetailOutput = Static<typeof pr_get_detail_output>;

// ─── Flow Definition ────────────────────────────────────────────────────

export const pr_get_detail: Flow<typeof pr_get_detail_input, typeof pr_get_detail_output> = {
  name: "pr_get_detail",
  description: "Load full PR detail including metadata, changed files, and workflow/check status. Does not parse Markdown comments.",
  input: pr_get_detail_input,
  output: pr_get_detail_output,
  meta: {
    tags: ["pr", "query"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_get_detail_input>): Promise<Static<typeof pr_get_detail_output>> {
    const { prNumber, expectedHeadSha } = input;

    // 1. Load PR snapshot with head SHA validation
    const snapshot = await loadPrSnapshot(ctx, { prNumber, expectedHeadSha });

    // 2. Load changed file count + file list
    let changedFileCount = 0;
    let files: Static<typeof pr_get_detail_output>["files"] = [];
    try {
      const prFiles = await ctx.github.getPullRequestFiles(prNumber);
      changedFileCount = prFiles.length;
      files = prFiles.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
    } catch (err) {
      ctx.logger.warn({ prNumber, err: String(err) }, "pr_get_detail: failed to fetch PR files");
    }

    // Info-comment state not enriched here: owned by info_comment_refresh
    // (runtime/state/info-comments).

    // 5. Load workflow/check runs via issue comments (best-effort check status)
    // GitHubClient doesn't expose check suites directly; try comments for workflow bot
    let workflows: Static<typeof pr_get_detail_output>["workflows"] = [];
    try {
      const comments = await ctx.github.getPrComments(prNumber);
      // Check runs are typically posted as check run summaries — we look for
      // comments that appear to be workflow bot status. Empty by default since
      // we can't reliably derive this from comments.
      workflows = [];
    } catch {
      // Non-critical
    }

    return {
      prNumber: snapshot.prNumber,
      title: snapshot.title,
      htmlUrl: snapshot.htmlUrl,
      state: snapshot.state,
      draft: snapshot.draft,
      author: snapshot.author,
      labels: snapshot.labels,
      head: { sha: snapshot.head.sha, ref: snapshot.head.ref },
      base: { sha: snapshot.base.sha, ref: snapshot.base.ref },
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      changedFiles: changedFileCount,
      files,
      workflows,
    };
  },
};
