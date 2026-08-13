// src/flows/compare/compare_upload.ts
// Flow: compare_upload - diff two uploaded text blobs into DiffRow[] + summary.
// Replaces inline algorithm previously in api/frontend/compare.ts POST /compare/upload.
// Pure computation (no I/O) — API layer reads File.text() before calling.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { parseTranslationContent, diffCompareMaps } from "@/flows/_shared/language/index.js";

// ─── Input Schema ────────────────────────────────────────────────────

export const compare_upload_input = Type.Object({
  textA: Type.String({ description: "Raw text content of first uploaded file" }),
  textB: Type.String({ description: "Raw text content of second uploaded file" }),
  nameA: Type.String({ description: "Filename of first upload (used to detect zh side)" }),
  nameB: Type.String({ description: "Filename of second upload (used to detect zh side)" }),
}, { additionalProperties: false });

export type CompareUploadInput = Static<typeof compare_upload_input>;

// ─── Output DTO (same shape as the now-removed compare_run) ──────────

export const compare_upload_output = Type.Object({
  rows: Type.Array(
    Type.Object({
      key: Type.String(),
      oldEnglish: Type.String(),
      newEnglish: Type.String(),
      oldChinese: Type.String(),
      newChinese: Type.String(),
      status: Type.Union([
        Type.Literal("new"),
        Type.Literal("modified"),
        Type.Literal("removed"),
        Type.Literal("unchanged"),
      ]),
      termCheck: Type.String(),
    }),
  ),
  summary: Type.Object({
    total: Type.Number(),
    new: Type.Number(),
    modified: Type.Number(),
    removed: Type.Number(),
    unchanged: Type.Number(),
  }),
});

export type CompareUploadOutput = Static<typeof compare_upload_output>;

// ─── Flow Definition ─────────────────────────────────────────────────

export const compare_upload: Flow<typeof compare_upload_input, typeof compare_upload_output> = {
  name: "compare_upload",
  description: "对比两个上传的翻译文件文本，返回 DiffRow[] 与统计摘要。纯计算，无 I/O。",
  input: compare_upload_input,
  output: compare_upload_output,
  meta: {
    tags: ["compare"],
    risk: "read",
    // effects: empty — pure computation (void ctx, no I/O)
    effects: [],
    timeoutMs: 10_000,
    agent_callable: false,
  },

  execute: async (ctx, input): Promise<CompareUploadOutput> => {
    void ctx;
    const { textA, textB, nameA } = input;

    const dataA = parseTranslationContent(textA);
    const dataB = parseTranslationContent(textB);
    const isAZh = nameA.toLowerCase().includes("zh");
    const { rows, summary } = diffCompareMaps(dataA, dataB, isAZh);
    return { rows, summary };
  },
};
