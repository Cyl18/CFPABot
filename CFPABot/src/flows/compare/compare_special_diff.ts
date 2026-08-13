// src/flows/compare/compare_special_diff.ts
// Flow: compare_special_diff - fetch paired base/head content for non-lang manual files
// in a PR, for the SpecialDiff Monaco diff view.
// Replaces inline algorithm previously in api/frontend/compare.ts GET /compare/:prId/special-diff.
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { loadFileAtRef } from "@/flows/_internal/load-file-at-ref.js";

// ─── Input Schema ────────────────────────────────────────────────────

export const compare_special_diff_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
}, { additionalProperties: false });

export type CompareSpecialDiffInput = Static<typeof compare_special_diff_input>;

// ─── Output DTO ──────────────────────────────────────────────────────

const SpecialDiffFileSchema = Type.Object({
  path: Type.String(),
  status: Type.String(),
  baseContent: Type.String(),
  headContent: Type.String(),
});

export const compare_special_diff_output = Type.Object({
  files: Type.Array(SpecialDiffFileSchema),
});

export type CompareSpecialDiffOutput = Static<typeof compare_special_diff_output>;

// ─── Flow Definition ─────────────────────────────────────────────────

export const compare_special_diff: Flow<typeof compare_special_diff_input, typeof compare_special_diff_output> = {
  name: "compare_special_diff",
  description: "获取 PR 中非语言文件的 base/head 配对内容，用于 SpecialDiff Monaco 对比视图。",
  input: compare_special_diff_input,
  output: compare_special_diff_output,
  meta: {
    tags: ["compare", "pr"],
    risk: "read",
    effects: ["github_read"],
    timeoutMs: 30_000,
    agent_callable: true,
  },

  execute: async (ctx, input): Promise<CompareSpecialDiffOutput> => {
    const { prNumber } = input;

    const [pr, rawFiles] = await Promise.all([
      ctx.github.getPullRequest(prNumber),
      ctx.github.getPullRequestFiles(prNumber),
    ]);

    const baseSha = pr.base?.sha;
    const headSha = pr.head?.sha;

    // Filter for non-lang text files (manual files)
    const manualFiles = rawFiles.filter(
      (f) => !f.filename.endsWith(".json") && !f.filename.endsWith(".lang")
        && !f.filename.includes("/lang/")
    );

    const fileResults = await Promise.allSettled(
      manualFiles.map(async (f) => {
        const path = f.filename;
        const status = f.status;

        let baseContent = "";
        let headContent = "";

        if (status !== "added" && baseSha) {
          try {
            const file = await loadFileAtRef(ctx, { path, ref: baseSha });
            if (file.content !== null) baseContent = file.content;
          } catch (err) {
            ctx.logger.warn({ err, source: "compare_special_diff", path }, "Failed to fetch base content");
          }
        }

        if (status !== "removed" && headSha) {
          try {
            const file = await loadFileAtRef(ctx, { path, ref: headSha });
            if (file.content !== null) headContent = file.content;
          } catch (err) {
            ctx.logger.warn({ err, source: "compare_special_diff", path }, "Failed to fetch head content");
          }
        }

        return { path, status, baseContent, headContent };
      })
    );

    const files = [];
    for (const result of fileResults) {
      if (result.status === "fulfilled") files.push(result.value);
    }

    return { files };
  },
};
