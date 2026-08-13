// src/__tests__/review-finalize-validate.test.ts
// 契约测试: review_finalize 输入校验纯函数 (validateReviewFinalize)。
// - finalRows 的 itemId 必须存在于 reviewTable; review 非空; severity 合法
// - dismissed 的 itemId 必须存在且当时是 flagged; 理由必填
// - 互斥: 同一 itemId 不得同时出现在 finalRows 与 dismissed

import { describe, expect, test } from "bun:test";
import { validateReviewFinalize } from "../agent/tools/review-finalize.js";
import type { ReviewAggRow, ReviewFinding } from "../agent/session-ctx.js";

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

  test("门禁: flagged 行含程序 error 候选但未处置 → 报错", () => {
    const t = [
      makeTableRow("id-e", "flagged"),
      { ...makeTableRow("id-f", "flagged"), findings: [{ origin: "program", severity: "error", issueType: "placeholder_count_mismatch", detail: "缺 %s" }] satisfies ReviewFinding[] },
    ];
    const { errors } = validateReviewFinalize({ finalRows: [], dismissed: [] }, t);
    expect(errors.some((e) => e.includes("程序 error 级候选未处置"))).toBe(true);
    expect(errors.some((e) => e.includes("id-f"))).toBe(true);
    expect(errors.some((e) => e.includes("id-e"))).toBe(false); // 无程序 error 意见的行不受门禁
  });

  test("门禁: 程序 error 候选采纳进 finalRows 即通过", () => {
    const t = [
      { ...makeTableRow("id-f", "flagged"), findings: [{ origin: "program", severity: "error", issueType: "placeholder_count_mismatch", detail: "缺 %s" }] satisfies ReviewFinding[] },
    ];
    const { errors } = validateReviewFinalize(
      { finalRows: [{ itemId: "id-f", key: "k", path: "p", severity: "error", review: "占位符缺失" }], dismissed: [] },
      t,
    );
    expect(errors.some((e) => e.includes("未处置"))).toBe(false);
  });

  test("门禁: 程序 error 候选驳回(带理由)即通过", () => {
    const t = [
      { ...makeTableRow("id-f", "flagged"), findings: [{ origin: "program", severity: "error", issueType: "placeholder_count_mismatch", detail: "缺 %s" }] satisfies ReviewFinding[] },
    ];
    const { errors } = validateReviewFinalize(
      { finalRows: [], dismissed: [{ itemId: "id-f", reason: "en 本身就有问题, 不适用" }] },
      t,
    );
    expect(errors.some((e) => e.includes("未处置"))).toBe(false);
  });

  test("门禁: 程序 warning / 模型 error 不强制处置", () => {
    const t = [
      { ...makeTableRow("id-g", "flagged"), findings: [{ origin: "program", severity: "warning", issueType: "punctuation_issue", detail: "标点" }] satisfies ReviewFinding[] },
      { ...makeTableRow("id-h", "flagged"), findings: [{ origin: "openai:gpt-4o", severity: "error", issueType: "consistency", detail: "术语不一致" }] satisfies ReviewFinding[] },
    ];
    const { errors } = validateReviewFinalize({ finalRows: [], dismissed: [] }, t);
    expect(errors.some((e) => e.includes("未处置"))).toBe(false);
  });

  test("门禁: 程序 error 候选驳回但缺理由 → 报错(理由必填)", () => {
    const t = [
      { ...makeTableRow("id-f", "flagged"), findings: [{ origin: "program", severity: "error", issueType: "placeholder_count_mismatch", detail: "缺 %s" }] satisfies ReviewFinding[] },
    ];
    const { errors } = validateReviewFinalize(
      { finalRows: [], dismissed: [{ itemId: "id-f", reason: "  " }] },
      t,
    );
    expect(errors.some((e) => e.includes("缺少驳回理由"))).toBe(true);
    expect(errors.some((e) => e.includes("未处置"))).toBe(true); // 驳回无效 → 仍视为未处置
  });
});
