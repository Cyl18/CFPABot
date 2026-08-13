// src/flows/pr/pr_get_context.ts
// Flow: pr_get_context — load PR metadata, labels, and changed file summary.
// Risk: read | Effects: github_read
// Uses loadPrSnapshot() internal + getPullRequestFiles() for file summary.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { loadPrSnapshot } from "../_internal/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const pr_get_context_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  expectedHeadSha: Type.Optional(
    Type.String({ description: "Fail STALE_HEAD if current head doesn't match" }),
  ),
});

export type PrGetContextInput = Static<typeof pr_get_context_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const pr_get_context_output = Type.Object({
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
  maintainerCanModify: Type.Optional(Type.Boolean()),
  changedFiles: Type.Array(
    Type.Object({
      filename: Type.String(),
      status: Type.String(),
      additions: Type.Number(),
      deletions: Type.Number(),
      changes: Type.Number(),
    }),
  ),
  totalChanges: Type.Object({
    files: Type.Number(),
    additions: Type.Number(),
    deletions: Type.Number(),
  }),
});

export type PrGetContextOutput = Static<typeof pr_get_context_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const pr_get_context: Flow<typeof pr_get_context_input, typeof pr_get_context_output> = {
  name: "pr_get_context",
  description: "Load PR metadata (title, author, state, labels, head/base SHA, branch) and a summary of all changed files. Used by Agent and Session prompt builder. **headSha 必须用全 SHA（40 位 hex），不要用截短形式——短 SHA 会导致 STALE_HEAD 拒绝（review_comment/pr_get_diff 均校验）**。",
  input: pr_get_context_input,
  output: pr_get_context_output,
  meta: {
    tags: ["pr", "query", "review"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_get_context_input>): Promise<Static<typeof pr_get_context_output>> {
    const { prNumber, expectedHeadSha } = input;

    // Load PR snapshot with optional head SHA validation
    const snapshot = await loadPrSnapshot(ctx, { prNumber, expectedHeadSha });

    // Fetch changed files for summary
    let prFiles: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    try {
      const files = await ctx.github.getPullRequestFiles(prNumber);
      for (const f of files) {
        prFiles.push({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        });
        totalAdditions += f.additions;
        totalDeletions += f.deletions;
      }
    } catch (err) {
      ctx.logger.warn({ prNumber, err: String(err) }, "pr_get_context: failed to fetch changed files");
      // Non-fatal — metadata still returned without file summary
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
      maintainerCanModify: undefined, // Not available from GitHubClient interface
      changedFiles: prFiles,
      totalChanges: {
        files: prFiles.length,
        additions: totalAdditions,
        deletions: totalDeletions,
      },
    };
  },
};
