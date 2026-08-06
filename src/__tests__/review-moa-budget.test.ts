// src/__tests__/review-moa-budget.test.ts
// 契约测试: review_moa 的预算驱动默认 batch/maxTokens (纯函数)。
// - 无 items / 无 specs → 下限
// - 大输入 + 1M context → batch 由输出预算主导, 明显大于 30
// - 小 context 模型 → 输入预算约束生效
// - clamp 上下限
// - maxTokens 随 batch 放大, 不超模型输出上限
// - resolvePromptText: /skill: 指令必须空格分隔(否则 SDK 展开失败)

import { describe, expect, test } from "bun:test";
import { computeDefaultBatchSize, computeDefaultMaxTokens, mergeMoaModelResult, remapFindingItemIds, type MoaReviewModelResult, type MoaReviewFinding } from "../agent/tools/review-moa.js";
import { extractTermCandidates } from "../agent/tools/terms-extract.js";
import { checkEntryFormat } from "../flows/_shared/language/format-checks.js";
import { validateToolSet } from "../agent/session-prompt.js";
import { resolvePromptText } from "../agent/session-prompt.js";
import { createCtxGetTool } from "../agent/tools/ctx.js";
import { setSessionCtx, clearSessionCtx, type ReviewAggRow, type ReviewFinding } from "../agent/session-ctx.js";
import { alignLangReviewItems, mergeAlignedItems } from "../flows/_shared/language/align-review-items.js";
import type { LangReviewItem } from "../flows/_shared/language/align-review-items.js";
import { aggregateReviewTable } from "../agent/review-aggregate.js";
import { validateReviewFinalize } from "../agent/tools/review-finalize.js";
import type { SessionRecord } from "../agent/session-types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function makeItem(seed: string, textLen = 40): LangReviewItem {
  const text = "x".repeat(textLen);
  return {
    itemId: `id-${seed}`,
    key: `key.${seed}`,
    mod: { slug: "chatpatches", gameVersion: "1.21-fabric", domain: "chatpatches" },
    path: `projects/assets/chatpatches/1.21-fabric/chatpatches/lang/zh_cn.json`,
    headEn: text,
    headZh: `中${text}`,
    changed: { en: true, zh: true },
    scope: "changed",
  };
}

const BIG_SPECS = [
  { contextWindow: 1_000_000, maxTokens: 64_000 }, // deepseek 类
  { contextWindow: 1_048_576, maxTokens: 131_072 }, // mimo 类
];

describe("computeDefaultBatchSize", () => {
  test("无 items 或 specs → 下限 10", () => {
    expect(computeDefaultBatchSize([], BIG_SPECS)).toBe(10);
    expect(computeDefaultBatchSize([makeItem("a")], [])).toBe(10);
  });

  test("500 条短文本 + 1M context → 预算计算值远超上限, clamp 到 30", () => {
    const items = Array.from({ length: 500 }, (_, i) => makeItem(String(i)));
    const batch = computeDefaultBatchSize(items, BIG_SPECS);
    expect(batch).toBe(30);
  });

  test("极小 context 模型(4k/2k) → 输入预算约束生效, batch 被压低", () => {
    const items = Array.from({ length: 500 }, (_, i) => makeItem(String(i)));
    const batch = computeDefaultBatchSize(items, [{ contextWindow: 4_000, maxTokens: 2_000 }]);
    // 输入预算 = (4k - 2k) * 0.8 ≈ 1.6k; 每条目 ≈ 98 → byInput ≈ 16
    expect(batch).toBeLessThan(30);
    expect(batch).toBeGreaterThanOrEqual(10);
  });

  test("超长条目(50000 字符/条) → 输入预算主导, batch 被压到 30 以下", () => {
    const longItems = Array.from({ length: 500 }, (_, i) => makeItem(String(i), 50_000));
    const shortItems = Array.from({ length: 500 }, (_, i) => makeItem(String(i)));
    expect(computeDefaultBatchSize(longItems, BIG_SPECS)).toBeLessThan(30); // byInput ≈ 17
    expect(computeDefaultBatchSize(longItems, BIG_SPECS)).toBeGreaterThanOrEqual(10);
    expect(computeDefaultBatchSize(longItems, BIG_SPECS)).toBeLessThan(
      computeDefaultBatchSize(shortItems, BIG_SPECS),
    );
  });

  test("显式 min/max clamp 生效", () => {
    const items = Array.from({ length: 500 }, (_, i) => makeItem(String(i)));
    expect(computeDefaultBatchSize(items, BIG_SPECS, { min: 10, max: 50 })).toBeLessThanOrEqual(50);
    expect(computeDefaultBatchSize(items, BIG_SPECS, { min: 10, max: 50 })).toBeGreaterThanOrEqual(10);
  });
});

describe("computeDefaultMaxTokens", () => {
  test("batch 大 → 输出上限放大, 不超模型能力", () => {
    expect(computeDefaultMaxTokens(500, 64_000)).toBe(64_000); // 500*200=100k → 截断到 64k
    expect(computeDefaultMaxTokens(300, 131_072)).toBe(60_000); // 300*200=60k
  });

  test("batch 小 → 保持 16384 下限", () => {
    expect(computeDefaultMaxTokens(30, 64_000)).toBe(16_384);
    expect(computeDefaultMaxTokens(80, 131_072)).toBe(16_384); // 80*200=16k < 16384
    expect(computeDefaultMaxTokens(82, 131_072)).toBe(16_400); // 82*200=16400
  });
});

describe("resolvePromptText skill 指令格式", () => {
  const base: SessionRecord = {
    sessionId: "s1",
    repo: { owner: "CFPAOrg", name: "Minecraft-Mod-Language-Package" },
    prNumber: 6105,
    headSha: "2b9eb355a8a18867dc53a79a9f8991d19e78cf3c",
    objective: "/skill:translation-review 完整审查",
    status: "running",
    messages: [],
  } as unknown as SessionRecord;

  test("/skill 指令用单空格分隔(参数区不含换行), SDK 展开可识别", () => {
    const text = resolvePromptText(base);
    expect(text.startsWith("/skill:translation-review ")).toBe(true);
    // SDK _expandSkillCommand: text.slice(7, text.indexOf(" ")) 必须恰好是 "translation-review"
    const spaceIndex = text.indexOf(" ");
    expect(text.slice(7, spaceIndex)).toBe("translation-review");
    // 参数区不得包含换行(换行会把 skill 名截断)
    expect(text.slice(spaceIndex)).not.toContain("\n");
  });

  test("head 使用全 SHA, 不截短", () => {
    const text = resolvePromptText(base);
    expect(text).toContain("2b9eb355a8a18867dc53a79a9f8991d19e78cf3c");
    expect(text).not.toContain("head 2b9eb35)");
  });

  test("非 skill objective 保持原格式", () => {
    const text = resolvePromptText({ ...base, objective: "普通目标" } as SessionRecord);
    expect(text).toContain("普通目标");
  });

  test("promptOverride 优先", () => {
    const text = resolvePromptText(base, "override");
    expect(text).toBe("override");
  });
});

describe("mergeMoaModelResult 渐进披露追加", () => {
  const modelA = (versions: string[] | undefined): MoaReviewModelResult => ({
    provider: "p1",
    modelId: "m1",
    ok: true,
    batches: [],
    totalFindings: 0,
    versions,
  });

  test("不同 versions 的轮次共存（多版本意见全部保留）", () => {
    const r1 = mergeMoaModelResult([], modelA(["26.2"]));
    const r2 = mergeMoaModelResult(r1, modelA(["1.21"]));
    const r3 = mergeMoaModelResult(r2, modelA(["1.20"]));
    expect(r3.map((r) => r.versions)).toEqual([["26.2"], ["1.21"], ["1.20"]]);
  });

  test("同 versions 重跑替换旧结果（修正语义，不重复）", () => {
    const first = mergeMoaModelResult([], modelA(["26.2"]));
    const again = mergeMoaModelResult(first, modelA(["26.2"]));
    expect(again).toHaveLength(1);
  });

  test("versions 顺序无关（排序后同 key）", () => {
    const a = mergeMoaModelResult([], modelA(["1.20", "1.21"]));
    const b = mergeMoaModelResult(a, modelA(["1.21", "1.20"]));
    expect(b).toHaveLength(1);
  });

  test("未传 versions（全量）与分版本轮次独立共存", () => {
    const a = mergeMoaModelResult([], modelA(undefined));
    const b = mergeMoaModelResult(a, modelA(["1.18"]));
    expect(b).toHaveLength(2);
  });
});

describe("ctx_get 投影（默认分页 + topIssue + 过滤）", () => {
  const row = (itemId: string, gameVersion: string, status: "pass" | "flagged", findings: ReviewFinding[]): ReviewAggRow => ({
    itemId,
    key: `key.${itemId}`,
    mod: { slug: "m", gameVersion, domain: "m" },
    path: `projects/assets/m/${gameVersion}/m/lang/zh_cn.json`,
    en: "en", zh: "zh",
    status,
    source: "moa",
    findings,
  });

  // ctx 参数仅满足签名, 实现未使用。
  const run = (params: unknown) =>
    createCtxGetTool("ctx-test").execute(
      "1", params, undefined, undefined,
      undefined as unknown as ExtensionContext,
    );

  // JSON.parse 是测试内构造数据的解码边界, 调用方给出期望形状。
  function parseBody<T>(res: { content: Array<{ type: string; text?: string }> }): T {
    const c = res.content[0];
    if (!c || c.type !== "text" || c.text === undefined) throw new Error("expected text content");
    return JSON.parse(c.text) as unknown as T;
  }

  test("reviewTable 未传参数默认分页 50 并带 truncated 标志", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(`id-${i}`, "1.21", i % 2 ? "flagged" : "pass", []),
    );
    setSessionCtx("ctx-test", { reviewTable: rows });
    try {
      const res = await run({ key: "reviewTable" });
      const body = parseBody<{
        total: number; filtered: number; truncated: boolean; data: unknown[];
      }>(res);
      expect(body.total).toBe(60);
      expect(body.data).toHaveLength(50);
      expect(body.truncated).toBe(true);
      expect(body.filtered).toBe(60);
    } finally {
      clearSessionCtx("ctx-test");
    }
  });

  test("status + version 过滤 + offset 翻页", async () => {
    const rows = [
      row("a", "26.2", "flagged", []),
      row("b", "26.2", "pass", []),
      row("c", "1.21", "flagged", []),
      row("d", "1.20", "flagged", []),
    ];
    setSessionCtx("ctx-test", { reviewTable: rows });
    try {
      const res = await run({ key: "reviewTable", status: "flagged", version: "26" });
      const body = parseBody<{ data: { itemId: string }[] }>(res);
      expect(body.data.map((r) => r.itemId)).toEqual(["a"]);
    } finally {
      clearSessionCtx("ctx-test");
    }
  });

  test("flagged 行附 topIssue（最高严重度意见一句话）", async () => {
    const rows = [
      row("a", "1.21", "flagged", [
        { origin: "p:m", severity: "info", issueType: "style", detail: "小问题" },
        { origin: "p:m", severity: "error", issueType: "grammar", detail: "语法错误说明文字" },
        { origin: "p:m", severity: "warning", issueType: "consistency", detail: "不一致" },
      ]),
    ];
    setSessionCtx("ctx-test", { reviewTable: rows });
    try {
      const res = await run({ key: "reviewTable", limit: 50 });
      const body = parseBody<{ data: { topIssue?: string; findings?: unknown[] }[] }>(res);
      expect(body.data[0]?.topIssue).toContain("error");
      expect(body.data[0]?.topIssue).toContain("grammar");
      expect(body.data[0]?.topIssue).toContain("语法错误说明文字");
      expect(body.data[0]?.findings).toHaveLength(3); // 原始 findings 仍保留
    } finally {
      clearSessionCtx("ctx-test");
    }
  });

  test("非大数组 key 不受默认分页影响", async () => {
    setSessionCtx("ctx-test", { dict: [{ word: "w", text: "t", source: "internal" }] });
    try {
      const res = await run({ key: "dict" });
      const body = parseBody<{ data: unknown[]; truncated?: boolean }>(res);
      expect(body.data).toHaveLength(1);
      expect(body.truncated).toBeUndefined();
    } finally {
      clearSessionCtx("ctx-test");
    }
  });
});

describe("mergeAlignedItems 跨版本合并", () => {
  const scope = { repoOwner: "o", repoName: "r", prNumber: 1, headSha: "a".repeat(40) };

  const mkResult = (gameVersion: string, key: string, headEn: string, headZh: string) =>
    alignLangReviewItems({
      baseEn: undefined,
      headEn: { [key]: headEn },
      baseZh: undefined,
      headZh: { [key]: headZh },
      mod: { slug: "m", gameVersion, domain: "m" },
      path: `projects/assets/m/${gameVersion}/m/lang/zh_cn.json`,
      scope,
    });

  test("同 key 同 headEn 跨版本合并为一条（多 zh 全保留）", () => {
    const { items } = mergeAlignedItems(
      [mkResult("26.2", "k1", "Hello", "你好"), mkResult("1.21", "k1", "Hello", "你好")],
      scope,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.versions?.map((v) => v.gameVersion)).toEqual(["26.2", "1.21"]);
    expect(items[0]?.versions?.map((v) => v.headZh)).toEqual(["你好", "你好"]);
    expect(items[0]?.zhVariant).toBeUndefined();
    expect(items[0]?.mod.gameVersion).toBe("26.2");
  });

  test("版本间 zh 不同 → zhVariant 标记（不拆开）", () => {
    const { items } = mergeAlignedItems(
      [mkResult("26.2", "k1", "Hello", "你好"), mkResult("1.21", "k1", "Hello", "您好")],
      scope,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.zhVariant).toBe(true);
  });

  test("headEn 不同 → 不合并", () => {
    const { items } = mergeAlignedItems(
      [mkResult("26.2", "k1", "Hello", "你好"), mkResult("1.21", "k1", "Hello!", "你好！")],
      scope,
    );
    expect(items).toHaveLength(2);
  });

  test("headEn 缺失(undefined) 与空串不撞组", () => {
    const undefRes = alignLangReviewItems({
      baseEn: undefined,
      headEn: {}, // k1 缺失 → hEn undefined
      baseZh: undefined,
      headZh: { k1: "旧" },
      mod: { slug: "m", gameVersion: "26.2", domain: "m" },
      path: "projects/assets/m/26.2/m/lang/zh_cn.json",
      scope,
    });
    const { items } = mergeAlignedItems([undefRes, mkResult("1.21", "k1", "", "空")], scope);
    expect(items).toHaveLength(2);
  });

  test("程序候选重映射到合并 id 并去重", () => {
    const mkStale = (gameVersion: string) =>
      alignLangReviewItems({
        baseEn: { k1: "Old" },
        headEn: { k1: "New" },
        baseZh: { k1: "旧" },
        headZh: { k1: "旧" },
        mod: { slug: "m", gameVersion, domain: "m" },
        path: `projects/assets/m/${gameVersion}/m/lang/zh_cn.json`,
        scope,
      });
    const { items, candidates } = mergeAlignedItems([mkStale("26.2"), mkStale("1.21")], scope);
    expect(items).toHaveLength(1);
    expect(candidates).toHaveLength(1); // 两版本同 (issueType, severity) 去重
    expect(candidates[0]?.itemId).toBe(items[0]?.itemId); // 重映射到合并 id
    expect(candidates[0]?.issueType).toBe("stale_translation");
  });

  test("scope 聚合：任一版本 changed → changed", () => {
    const historical = alignLangReviewItems({
      baseEn: { k1: "Same" },
      headEn: { k1: "Same" },
      baseZh: { k1: "相同" },
      headZh: { k1: "相同" },
      mod: { slug: "m", gameVersion: "26.2", domain: "m" },
      path: "projects/assets/m/26.2/m/lang/zh_cn.json",
      scope,
    });
    const { items } = mergeAlignedItems([historical, mkResult("1.21", "k1", "Same", "新译")], scope);
    expect(items).toHaveLength(1);
    expect(items[0]?.scope).toBe("changed");
  });
});

describe("序号 itemId 映射与脏 id 归属", () => {
  const scope = { repoOwner: "o", repoName: "r", prNumber: 1, headSha: "a".repeat(40) };

  test("remapFindingItemIds：序号 → batch 内真实 id", () => {
    const ids = ["id-a", "id-b", "id-c"];
    const findings: MoaReviewFinding[] = [
      { itemId: "0", key: "k0", severity: "warning" },
      { itemId: "2", key: "k2", severity: "info" },
      { itemId: "99", key: "k99", severity: "info" }, // 越界 → 保留原值
      { itemId: "abc", key: "kabc", severity: "info" }, // 非数字 → 保留
      { key: "k-only", severity: "info" }, // 无 itemId → 不动
    ];
    const mapped = remapFindingItemIds(findings, ids);
    expect(mapped[0]?.itemId).toBe("id-a");
    expect(mapped[1]?.itemId).toBe("id-c");
    expect(mapped[2]?.itemId).toBe("99");
    expect(mapped[3]?.itemId).toBe("abc");
    expect(mapped[4]?.itemId).toBeUndefined();
  });

  const buildAligned = (pairs: { key: string; gameVersion: string; domain: string }[]) => {
    const results = pairs.map(({ key, gameVersion, domain }) =>
      alignLangReviewItems({
        baseEn: undefined,
        headEn: { [key]: "En" },
        baseZh: undefined,
        headZh: { [key]: "译" },
        mod: { slug: "m", gameVersion, domain },
        path: `projects/assets/m/${gameVersion}/${domain}/lang/zh_cn.json`,
        scope,
      }),
    );
    const merged = mergeAlignedItems(results, scope);
    return [{ items: merged.items, candidates: merged.candidates }];
  };

  const moaResult = (itemIds: string[], findings: MoaReviewFinding[]) =>
    [
      {
        provider: "openai",
        modelId: "m1",
        ok: true,
        batches: [{ batchIndex: 0, reviewedItems: itemIds.length, itemIds, findings }],
        totalFindings: findings.length,
      },
    ] as MoaReviewModelResult[];

  test("模型拼接垃圾 id + key 唯一 → key fuzzy 修复归属", () => {
    const aligned = buildAligned([{ key: "block.m.hello", gameVersion: "26.2", domain: "m" }]);
    const real = aligned[0]!.items[0]!;
    // 模型返回垃圾 id（真实 id 前缀 + 尾巴），key 正确 → 按 key 修复
    const reviews = moaResult([real.itemId], [
      { itemId: real.itemId.slice(0, 8) + "deadbeef", key: real.key, severity: "warning", issueType: "style", detail: "d" },
    ]);
    const { rows } = aggregateReviewTable(reviews, aligned);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.itemId).toBe(real.itemId);
    expect(rows[0]!.unknownItem).toBeUndefined();
    expect(rows[0]!.status).toBe("flagged");
  });

  test("itemId 未知 + key 多命中（同 key 多文件）→ unknownItem 兜底", () => {
    const aligned = buildAligned([
      { key: "block.m.same", gameVersion: "26.2", domain: "a" },
      { key: "block.m.same", gameVersion: "1.21", domain: "b" },
    ]);
    const reviews = moaResult(aligned[0]!.items.map((i) => i.itemId), [
      { itemId: "garbage-id", key: "block.m.same", severity: "error", issueType: "missing", detail: "d" },
    ]);
    const { rows } = aggregateReviewTable(reviews, aligned);
    expect(rows).toHaveLength(3); // 2 真实 + 1 兜底
    const unknown = rows.find((r) => r.unknownItem);
    expect(unknown).toBeDefined();
    expect(unknown?.key).toBe("garbage-id");
    expect(unknown?.status).toBe("flagged"); // 意见保留，agent 可见
  });

  test("finalize 拒绝引用 unknownItem 行", () => {
    const table: ReviewAggRow[] = [
      {
        itemId: "garbage-id",
        key: "garbage-id",
        mod: { slug: "", gameVersion: "", domain: "" },
        path: "",
        status: "flagged",
        source: "moa",
        findings: [{ origin: "moa", severity: "error", issueType: "missing", detail: "d" }],
        unknownItem: true,
      },
    ];
    const { errors } = validateReviewFinalize(
      { finalRows: [{ itemId: "garbage-id", key: "k", path: "p", severity: "error", review: "r" }], dismissed: [] },
      table,
    );
    expect(errors.some((e) => e.includes("不存在于 reviewTable"))).toBe(true);
  });

  test("fuzzy 修复后 validItemIds 快照不含兜底行（finalize 成功路径行可引用）", () => {
    const aligned = buildAligned([{ key: "block.m.ok", gameVersion: "26.2", domain: "m" }]);
    const real = aligned[0]!.items[0]!;
    const reviews = moaResult([real.itemId], [
      { itemId: "0", key: real.key, severity: "warning", issueType: "style", detail: "d" },
    ]);
    const { rows } = aggregateReviewTable(reviews, aligned);
    expect(rows[0]!.itemId).toBe(real.itemId);
    expect(rows[0]!.unknownItem).toBeUndefined();
  });
});

describe("terms_extract n-gram 候选", () => {
  const item = (key: string, en: string, zh: string): LangReviewItem => ({
    itemId: `id-${key}`,
    key,
    mod: { slug: "m", gameVersion: "26.2", domain: "m" },
    path: `projects/assets/m/26.2/m/lang/zh_cn.json`,
    headEn: en,
    headZh: zh,
    changed: { en: true, zh: true },
    scope: "changed",
  });

  test("n=1 单词频 + stop word 过滤 + refs 收集", () => {
    const items = [
      item("k1", "Redstone Link range", "红石线链接范围"),
      item("k2", "Redstone Link speed", "红石线链接速度"),
      item("k3", "Redstone signal", "红石信号"),
      item("k4", "the of and", "虚词"), // 全 stop words → 丢弃
    ];
    const candidates = extractTermCandidates(items, { n: 1 });
    expect(candidates.map((c) => c.word)).toEqual(["Redstone", "Link"]);
    expect(candidates[0]?.freq).toBe(3);
    expect(candidates[0]?.refs).toHaveLength(3);
    expect(candidates[0]?.refs[0]?.en).toBe("Redstone Link range");
    expect(candidates[0]?.refs[0]?.zh).toBe("红石线链接范围");
  });

  test("n=2 双词短语（默认）+ refs 回扫", () => {
    const items = [
      item("k1", "Redstone Link range", "红石线链接范围"),
      item("k2", "Redstone Link speed", "红石线链接速度"),
      item("k3", "Redstone signal", "红石信号"),
    ];
    const candidates = extractTermCandidates(items, {});
    expect(candidates.map((c) => c.word)).toEqual(["Redstone Link"]); // freq=2；Redstone signal freq=1 <2
    expect(candidates[0]?.refs).toHaveLength(2);
    expect(candidates[0]?.refs[0]?.key).toBe("k1");
  });

  test("混合 stop word 短语保留，全 stop word 短语丢弃", () => {
    const kept = extractTermCandidates(
      [item("k1", "point of interest A", "兴趣点甲"), item("k2", "point of interest B", "兴趣点乙")],
      {},
    );
    expect(kept.map((c) => c.word)).toEqual(["point of"]);
    const dropped = extractTermCandidates(
      [item("k1", "of the night", "夜晚"), item("k2", "of the day", "白天")],
      {},
    );
    expect(dropped).toHaveLength(0);
  });

  test("minFreq 门槛与 maxTerms 截断", () => {
    const items = [
      item("k1", "Alpha Beta", "甲 乙"),
      item("k2", "Alpha Beta", "甲 乙"),
      item("k3", "Gamma Delta", "丙 丁"),
      item("k4", "Gamma Delta", "丙 丁"),
    ];
    const candidates = extractTermCandidates(items, { maxTerms: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.freq).toBe(2);
  });

  test("短词过滤 + historical 条目不统计", () => {
    const items = [
      item("k1", "hp 3 42slot", "生命 3 42槽"),
      item("k2", "HP bar", "生命条"),
      { ...item("k3", "Redstone", "红石"), scope: "historical" as const, changed: { en: false, zh: false } },
    ];
    const candidates = extractTermCandidates(items, { n: 1, minLen: 2 });
    expect(candidates.map((c) => c.word.toLowerCase())).toEqual(["hp"]); // bar/42slot freq=1；historical Redstone 不统计
    expect(candidates[0]?.refs).toHaveLength(2);
  });

  test("version 过滤：只统计涉及指定版本的条目，zh 取该版本", () => {
    const items = [
      { ...item("k1", "Redstone Link", "红石线链接"), versions: [
        { gameVersion: "26.2", path: "p1", headZh: "红石线链接" },
        { gameVersion: "1.21", path: "p2", headZh: "红石线" },
      ] },
      { ...item("k2", "Redstone signal", "红石信号"), versions: [
        { gameVersion: "1.21", path: "p2", headZh: "红石信号" },
      ] },
      item("k3", "Wood plank", "木板"), // 未合并条目（1.21 之外无版本信息 → mod.gameVersion 无匹配）
    ];
    const candidates = extractTermCandidates(items, { n: 1, version: "1.21" });
    // k1（涉及 1.21）与 k2 统计；k3 mod.gameVersion="26.2" 不涉及 1.21 → 排除
    expect(candidates.map((c) => c.word.toLowerCase())).toEqual(["redstone"]); // freq=2；link/signal freq=1
    // zh 取 1.21 版本：k1 → "红石线"
    const entry = candidates.find((c) => c.word === "Redstone");
    expect(entry?.refs.some((r) => r.zh === "红石线")).toBe(true);
  });
});

describe("checkEntryFormat 确定性格式检查", () => {
  test("占位符数量不一致（en 2 个 %s zh 1 个）→ error", () => {
    const findings = checkEntryFormat("item.m.foo", "Hello %s and %s", "你好 %s");
    expect(findings.some((f) => f.issueType === "placeholder_count_mismatch" && f.severity === "error")).toBe(true);
  });

  test("位置占位符归一化：%1$s 与 %s 等价不报", () => {
    const findings = checkEntryFormat("item.m.foo", "Hello %1$s", "你好 %s");
    expect(findings.filter((f) => f.issueType === "placeholder_count_mismatch")).toHaveLength(0);
  });

  test("§ 色码数量不一致 → special_tag_mismatch", () => {
    const findings = checkEntryFormat("item.m.foo", "§aGreen §bBlue", "§a绿色 §b蓝色 §c红");
    expect(findings.some((f) => f.issueType === "special_tag_mismatch" && f.severity === "error")).toBe(true);
  });

  test("tellraw 非 text 键被修改 → tellraw_mismatch", () => {
    const en = '{"text":"Hello","color":"red","extra":[{"text":"World"}]}';
    const zh = '{"text":"你好","color":"blue","extra":[{"text":"世界"}]}';
    const findings = checkEntryFormat("item.m.foo", en, zh);
    expect(findings.some((f) => f.issueType === "tellraw_mismatch" && f.detail.includes("color"))).toBe(true);
  });

  test("唱片名不应翻译 → music_disc_translated", () => {
    const findings = checkEntryFormat("music_disc.c418.desc", "C418 - Cat", "猫");
    expect(findings.some((f) => f.issueType === "music_disc_translated")).toBe(true);
  });

  test("标点：中文句中半角句号 → punctuation_issue", () => {
    const findings = checkEntryFormat("item.m.foo", "Hello world", "你好.世界");
    expect(findings.some((f) => f.issueType === "punctuation_issue")).toBe(true);
  });

  test("能量单位被翻译 → energy_unit_translated", () => {
    const findings = checkEntryFormat("item.m.foo", "Energy: 100 FE", "能量：100 锻造能量");
    expect(findings.some((f) => f.issueType === "energy_unit_translated" && f.detail.includes("FE"))).toBe(true);
  });

  test("三个英文句号 → ellipsis_issue", () => {
    const findings = checkEntryFormat("item.m.foo", "Loading...", "加载...");
    expect(findings.some((f) => f.issueType === "ellipsis_issue")).toBe(true);
  });

  test("声音字幕缺 主体：声音 → subtitle_format_issue", () => {
    const findings = checkEntryFormat("subtitles.m.bee_buzz", "Bee buzzes", "蜜蜂嗡嗡");
    expect(findings.some((f) => f.issueType === "subtitle_format_issue")).toBe(true);
    // 已有冒号 → 不报
    const ok = checkEntryFormat("subtitles.m.bee_buzz", "Bee buzzes", "蜜蜂：嗡嗡");
    expect(ok.filter((f) => f.issueType === "subtitle_format_issue")).toHaveLength(0);
  });
});

describe("validateToolSet extension 工具兼容", () => {
  test("extra 工具（pi-mcp-adapter 注册的 mcp/mcp_script）不报错", () => {
    const expected = new Set(["review_align", "review_moa", "dict_lookup"]);
    const active = new Set(["review_align", "review_moa", "dict_lookup", "mcp", "mcp_script"]);
    expect(validateToolSet(active, expected)).toBeNull();
  });

  test("missing 期望工具仍报错", () => {
    const expected = new Set(["review_align", "review_moa", "dict_lookup"]);
    const active = new Set(["review_align", "mcp"]);
    const err = validateToolSet(active, expected);
    expect(err).toContain("review_moa");
    expect(err).toContain("dict_lookup");
    expect(err).not.toContain("mcp");
  });
});
