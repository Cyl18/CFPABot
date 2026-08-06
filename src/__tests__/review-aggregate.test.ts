// src/__tests__/review-aggregate.test.ts
// 契约测试: 聚合中间表 (review_aggregate 纯函数)。
// 关键契约:
// - 模型失败 ≠ pass: error batch 覆盖 → unreviewed, 绝不推导为 pass
// - findings=[] 仅在成功时推导 pass
// - 程序候选按 itemId join, 可覆盖 historical 条目; flagged 不被 error 降级
// - 多模型分歧 → conflict
// - key-only finding 只在同 batch 内消歧, 多命中跳过并计数
// - dismissed 审计幂等保留

import { describe, expect, test } from "bun:test";
import { aggregateReviewTable, summarizeReviewTable } from "../agent/review-aggregate.js";
import type { LangReviewItem } from "../flows/_shared/language/align-review-items.js";
import type { MoaReviewModelResult } from "../agent/tools/review-moa.js";

function makeItem(partial: Partial<LangReviewItem> & { itemId: string; key: string }): LangReviewItem {
  return {
    itemId: partial.itemId,
    key: partial.key,
    mod: partial.mod ?? { slug: "testmod", gameVersion: "1.20.1", domain: "mcw" },
    path: partial.path ?? "projects/1.20.1/testmod/zh_cn.json",
    headEn: partial.headEn,
    headZh: partial.headZh,
    baseEn: partial.baseEn,
    baseZh: partial.baseZh,
    changed: partial.changed ?? { en: true, zh: true },
    scope: partial.scope ?? "changed",
  };
}

function makeModelResult(
  provider: string,
  modelId: string,
  batches: MoaReviewModelResult["batches"],
): MoaReviewModelResult {
  return { provider, modelId, ok: true, batches, totalFindings: batches.reduce((s, b) => s + b.findings.length, 0) };
}

describe("aggregateReviewTable", () => {
  const itemA = makeItem({ itemId: "id-a", key: "key.a", headEn: "Apple", headZh: "苹果" });
  const itemB = makeItem({ itemId: "id-b", key: "key.b", headEn: "Banana", headZh: "香蕉" });
  const itemC = makeItem({ itemId: "id-c", key: "key.c", headEn: "Cherry", headZh: "樱桃" });

  test("成功且无 findings 推导 pass；有 findings 标 flagged", () => {
    const reviews = [
      makeModelResult("p1", "m1", [
        { batchIndex: 0, reviewedItems: 2, itemIds: ["id-a", "id-b"], findings: [] },
      ]),
      makeModelResult("p2", "m2", [
        { batchIndex: 0, reviewedItems: 2, itemIds: ["id-a", "id-b"], findings: [
          { itemId: "id-a", severity: "error", detail: "漏译" },
        ] },
      ]),
    ];
    const { rows } = aggregateReviewTable(reviews, []);
    const a = rows.find((r) => r.itemId === "id-a")!;
    const b = rows.find((r) => r.itemId === "id-b")!;
    expect(a.status).toBe("flagged");
    expect(a.conflict).toBe(true); // m1 pass, m2 flag
    expect(b.status).toBe("pass");
    expect(b.findings).toHaveLength(0);
  });

  test("error batch 覆盖 → unreviewed，绝不等于 pass", () => {
    const reviews = [
      makeModelResult("p1", "m1", [
        { batchIndex: 0, reviewedItems: 1, itemIds: ["id-a"], findings: [], error: "LLM 调用失败" },
      ]),
    ];
    const { rows } = aggregateReviewTable(reviews, []);
    expect(rows.find((r) => r.itemId === "id-a")!.status).toBe("unreviewed");
  });

  test("程序候选 flagged 不被模型 error 降级", () => {
    const aligned = [{
      items: [itemA],
      candidates: [{ itemId: "id-a", issueType: "missing_translation", severity: "error" }],
    }];
    const reviews = [
      makeModelResult("p1", "m1", [
        { batchIndex: 0, reviewedItems: 1, itemIds: ["id-a"], findings: [], error: "解析失败" },
      ]),
    ];
    const { rows } = aggregateReviewTable(reviews, aligned);
    const a = rows.find((r) => r.itemId === "id-a")!;
    expect(a.status).toBe("flagged"); // 程序必改意见优先于 unreviewed
    expect(a.source).toBe("program");
    expect(a.findings[0]!.origin).toBe("program");
  });

  test("程序候选可覆盖 historical 条目（表不假设 ⊆ changed）", () => {
    const itemHist = makeItem({ itemId: "id-hist", key: "hist", scope: "historical" });
    const aligned = [{
      items: [itemHist],
      candidates: [{ itemId: "id-hist", issueType: "format_mismatch", severity: "warning" }],
    }];
    const { rows } = aggregateReviewTable(undefined, aligned);
    const h = rows.find((r) => r.itemId === "id-hist")!;
    expect(h.status).toBe("flagged");
    expect(h.source).toBe("program");
  });

  test("key-only finding 同 batch 恰好 1 个命中才归属", () => {
    const reviews = [
      makeModelResult("p1", "m1", [
        {
          batchIndex: 0, reviewedItems: 2, itemIds: ["id-a", "id-b"],
          findings: [{ key: "key.a", severity: "warning", detail: "措辞" }],
        },
      ]),
    ];
    const { rows } = aggregateReviewTable(reviews, [{ items: [itemA, itemB], candidates: [] }]);
    const a = rows.find((r) => r.itemId === "id-a")!;
    expect(a.status).toBe("flagged");
    expect(a.findings[0]!.origin).toBe("p1:m1");
  });

  test("key-only finding 同 batch 多命中 → 跳过并计数 ambiguousFindings", () => {
    const itemA2 = makeItem({ itemId: "id-a2", key: "key.a", path: "projects/1.20.1/other/zh_cn.json" });
    const aligned = [{ items: [itemA, itemA2], candidates: [] }];
    const reviews = [
      makeModelResult("p1", "m1", [
        {
          batchIndex: 0, reviewedItems: 2, itemIds: ["id-a", "id-a2"],
          findings: [{ key: "key.a", severity: "error" }],
        },
      ]),
    ];
    const { rows, ambiguousFindings } = aggregateReviewTable(reviews, aligned);
    expect(ambiguousFindings).toBe(1);
    expect(rows.filter((r) => r.findings.length > 0)).toHaveLength(0);
    // 两行都还在（pass 覆盖推导）—— 但无意见
    expect(rows.map((r) => r.itemId).sort()).toEqual(["id-a", "id-a2"].sort());
  });

  test("fallback 产出的 batch 归属实际 origin（非声明模型）", () => {
    const reviews = [
      makeModelResult("p1", "m1", [
        {
          batchIndex: 0, reviewedItems: 1, itemIds: ["id-a"],
          findings: [{ itemId: "id-a", severity: "error", detail: "fallback 产出" }],
          fallbackOrigin: "agent:main-model",
        },
      ]),
    ];
    const { rows } = aggregateReviewTable(reviews, [{ items: [itemA], candidates: [] }]);
    const a = rows.find((r) => r.itemId === "id-a")!;
    expect(a.status).toBe("flagged");
    expect(a.findings[0]!.origin).toBe("agent:main-model");
    expect(a.source).toBe("moa");
  });

  test("fallback 与声明模型分别 flag → 按实际 origin 计 conflict", () => {
    const reviews = [
      makeModelResult("p1", "m1", [
        { batchIndex: 0, reviewedItems: 1, itemIds: ["id-a"], findings: [{ itemId: "id-a", severity: "warning" }] },
        {
          batchIndex: 1, reviewedItems: 1, itemIds: ["id-a"],
          findings: [{ itemId: "id-a", severity: "error" }],
          fallbackOrigin: "agent:main-model",
        },
      ]),
      makeModelResult("agent", "main-model", [
        { batchIndex: 0, reviewedItems: 1, itemIds: ["id-a"], findings: [] },
      ]),
    ];
    const { rows } = aggregateReviewTable(reviews, [{ items: [itemA], candidates: [] }]);
    const a = rows.find((r) => r.itemId === "id-a")!;
    // 有意见 origin: p1:m1 + agent:main-model = 2 个；成功覆盖 origin: p1:m1 + agent:main-model = 2 个
    // （fallback batch 与真实 agent batch 都算 agent:main-model）→ covered == flagged → 无分歧
    // （旧实现 fallback 记在 p1:m1 名下: covered=2 > flagged=1 → 误判 conflict=true）
    expect(a.conflict).toBeUndefined();
  });

  test("dismissed 审计幂等保留", () => {
    const reviews = [
      makeModelResult("p1", "m1", [
        { batchIndex: 0, reviewedItems: 1, itemIds: ["id-a"], findings: [{ itemId: "id-a", severity: "error" }] },
      ]),
    ];
    const existing = [{
      itemId: "id-a", key: "key.a",
      mod: { slug: "testmod", gameVersion: "1.20.1", domain: "mcw" },
      path: "p", status: "flagged" as const, source: "moa" as const, findings: [],
      dismissed: { by: "agent" as const, reason: "过于严厉", at: "2026-08-01T00:00:00Z" },
    }];
    const { rows } = aggregateReviewTable(reviews, [], existing);
    expect(rows.find((r) => r.itemId === "id-a")!.dismissed?.reason).toBe("过于严厉");
  });

  test("summarizeReviewTable 统计正确", () => {
    const rows = [
      { itemId: "1", key: "a", mod: { slug: "s", gameVersion: "v", domain: "d" }, path: "p", status: "flagged" as const, source: "moa" as const, findings: [], conflict: true },
      { itemId: "2", key: "b", mod: { slug: "s", gameVersion: "v", domain: "d" }, path: "p", status: "pass" as const, source: "moa" as const, findings: [] },
      { itemId: "3", key: "c", mod: { slug: "s", gameVersion: "v", domain: "d" }, path: "p", status: "unreviewed" as const, source: "moa" as const, findings: [] },
    ];
    const s = summarizeReviewTable(rows, 2);
    expect(s).toEqual({ total: 3, flagged: 1, pass: 1, unreviewed: 1, conflict: 1, dismissed: 0, ambiguousFindings: 2 });
  });
});
