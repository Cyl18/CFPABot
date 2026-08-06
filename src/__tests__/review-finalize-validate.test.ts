// src/__tests__/review-finalize-validate.test.ts
// 契约测试: review_finalize 输入校验纯函数 (validateReviewFinalize)。
// - finalRows 的 itemId 必须存在于 reviewTable; review 非空; severity 合法
// - dismissed 的 itemId 必须存在且当时是 flagged; 理由必填
// - 互斥: 同一 itemId 不得同时出现在 finalRows 与 dismissed

import { describe, expect, test } from "bun:test";
import { validateReviewFinalize } from "../agent/tools/review-finalize.js";
import type { ReviewAggRow } from "../agent/session-ctx.js";

function makeTableRow(itemId: string, status: ReviewAggRow["status"]): ReviewAggRow {
  return {
    itemId,
    key: `key.${itemId}`,
    mod: { slug: "testmod", gameVersion: "1.20.1", domain: "mcw" },
    path: "projects/1.20.1/testmod/zh_cn.json",
    status,
    source: "moa",
    findings: [],
  };
}

const table = [makeTableRow("id-a", "flagged"), makeTableRow("id-b", "pass"), makeTableRow("id-c", "unreviewed"), makeTableRow("id-d", "flagged")];

describe("validateReviewFinalize", () => {
  test("合法输入通过, 返回整理后的 finalRows", () => {
    const { errors, finalRows } = validateReviewFinalize(
      {
        finalRows: [{ itemId: "id-a", key: "key.id-a", path: "p", severity: "error", review: "漏译" }],
        dismissed: [{ itemId: "id-d", reason: "模型失败, 无从验证" }],
      },
      table,
    );
    expect(errors).toHaveLength(0);
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]!.severity).toBe("error");
  });

  test("finalRows 的 itemId 不存在于 reviewTable → 报错", () => {
    const { errors, finalRows } = validateReviewFinalize(
      { finalRows: [{ itemId: "id-ghost", key: "k", path: "p", severity: "warning", review: "x" }], dismissed: [] },
      table,
    );
    expect(errors.some((e) => e.includes("id-ghost"))).toBe(true);
    expect(finalRows).toHaveLength(0);
  });

  test("finalRows 的 review 为空 → 报错", () => {
    const { errors } = validateReviewFinalize(
      { finalRows: [{ itemId: "id-a", key: "k", path: "p", severity: "warning", review: "   " }], dismissed: [] },
      table,
    );
    expect(errors.some((e) => e.includes("review 为空"))).toBe(true);
  });

  test("dismissed 的 itemId 不是 flagged → 报错", () => {
    const { errors } = validateReviewFinalize(
      { finalRows: [], dismissed: [{ itemId: "id-b", reason: "误报" }] },
      table,
    );
    expect(errors.some((e) => e.includes("不是 flagged"))).toBe(true);
  });

  test("dismissed 缺少理由 → 报错", () => {
    const { errors } = validateReviewFinalize(
      { finalRows: [], dismissed: [{ itemId: "id-a", reason: "" }] },
      table,
    );
    expect(errors.some((e) => e.includes("缺少驳回理由"))).toBe(true);
  });

  test("互斥: 同一 itemId 同时出现在 finalRows 与 dismissed → 报错, 不进 finalRows", () => {
    const { errors, finalRows } = validateReviewFinalize(
      {
        finalRows: [{ itemId: "id-a", key: "k", path: "p", severity: "warning", review: "意见" }],
        dismissed: [{ itemId: "id-a", reason: "误报" }],
      },
      table,
    );
    expect(errors.some((e) => e.includes("同时包含"))).toBe(true);
    expect(finalRows).toHaveLength(0);
  });
});
