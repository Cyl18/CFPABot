// src/__tests__/tm.test.ts
// 翻译记忆(TM)纯函数测试 — BM25 排序、模糊匹配(编辑距离)、多译法候选、边界。
//
// Coverage:
//   ✅  buildTmIndex: (en,zh) 去重合并计数、多译法保留、倒排表/df/avgDocLen
//   ✅  searchTm: BM25 相关词排前、多候选(同 en 不同 zh 全返回)、topK、空 query/空索引
//   ✅  fuzzyFind: 错拼召回(词级/整串)、距离升序、maxDist 过滤、空 query/空索引
//   ✅  tokenize: 小写 + 空白/标点切分
//   ✅  levenshtein: 手写编辑距离正确性

import { describe, expect, it } from "bun:test";
import {
  buildTmIndex,
  searchTm,
  fuzzyFind,
  levenshtein,
  tokenize,
  type TmEntry,
} from "../flows/_shared/terminology/index.js";

describe("tokenize", () => {
  it("小写并按空白/标点切分", () => {
    expect(tokenize("Crafting Table, 'Netherite' Sword!")).toEqual([
      "crafting",
      "table",
      "netherite",
      "sword",
    ]);
  });

  it("空串/纯标点产出空词元列表", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("  ,.!? ")).toEqual([]);
  });
});

describe("levenshtein", () => {
  it("相同串距离为 0", () => {
    expect(levenshtein("table", "table")).toBe(0);
  });

  it("插入/删除/替换各计 1", () => {
    expect(levenshtein("table", "tables")).toBe(1); // 插入
    expect(levenshtein("table", "tabl")).toBe(1); // 删除
    expect(levenshtein("table", "tabke")).toBe(1); // 替换
    expect(levenshtein("crafting", "craftin")).toBe(1);
  });

  it("空串距离等于另一串长度", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
});

describe("buildTmIndex", () => {
  it("同 en 同 zh 合并计数, 同 en 不同 zh 全部保留", () => {
    const index = buildTmIndex([
      { en: "Table", zh: "桌子", path: "a/zh_cn.json" },
      { en: "Table", zh: "桌子", path: "b/zh_cn.json" },
      { en: "Table", zh: "工作台", path: "a/zh_cn.json" },
      { en: "Chair", zh: "椅子", path: "a/zh_cn.json" },
    ]);
    expect(index.totalDocs).toBe(3);
    const tableDocs = index.docs.filter((d) => d.en === "Table");
    expect(tableDocs).toHaveLength(2);
    const deduped = tableDocs.find((d) => d.zh === "桌子")!;
    expect(deduped.freq).toBe(2);
    expect(deduped.path).toBe("a/zh_cn.json"); // 保留首个 path
    expect(index.docs.find((d) => d.en === "Chair")!.freq).toBe(1);
  });

  it("倒排表与文档频率正确", () => {
    const index = buildTmIndex([
      { en: "Iron Sword", zh: "铁剑", path: "a" },
      { en: "Iron Pickaxe", zh: "铁镐", path: "b" },
    ]);
    expect(index.postings["iron"]).toEqual([0, 1]);
    expect(index.df["iron"]).toBe(2);
    expect(index.postings["sword"]).toEqual([0]);
    expect(index.df["sword"]).toBe(1);
    expect(index.avgDocLen).toBe(2);
  });

  it("空语料产出空索引", () => {
    const index = buildTmIndex([]);
    expect(index.totalDocs).toBe(0);
    expect(index.avgDocLen).toBe(0);
    expect(Object.keys(index.postings)).toHaveLength(0);
  });
});

describe("searchTm (BM25)", () => {
  const corpus: TmEntry[] = [
    { en: "Crafting Table", zh: "工作台", path: "p1" },
    { en: "Crafting Table", zh: "合成台", path: "p2" },
    { en: "Crafting", zh: "合成", path: "p3" },
    { en: "Iron Sword", zh: "铁剑", path: "p4" },
    { en: "Diamond Sword", zh: "钻石剑", path: "p5" },
  ];

  it("相关词排前: 同时含两个查询词的文档排第一", () => {
    const index = buildTmIndex(corpus);
    const hits = searchTm(index, "crafting table");
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits[0]!.en).toBe("Crafting Table"); // 双词命中得分最高
    const craftingOnly = hits.find((h) => h.en === "Crafting");
    expect(craftingOnly).toBeDefined();
    expect(hits[0]!.score).toBeGreaterThan(craftingOnly!.score); // 双词 > 单词
    expect(hits.map((h) => h.en)).toContain("Crafting");
  });

  it("多候选: 同一 en 的不同 zh 全部返回, 不去重", () => {
    const index = buildTmIndex(corpus);
    const hits = searchTm(index, "crafting table");
    const zhSet = new Set(hits.filter((h) => h.en === "Crafting Table").map((h) => h.zh));
    expect(zhSet).toEqual(new Set(["工作台", "合成台"]));
  });

  it("无关查询返回空", () => {
    const index = buildTmIndex(corpus);
    expect(searchTm(index, "zombie pigman")).toEqual([]);
  });

  it("topK 默认 5, 可显式限制", () => {
    const entries: TmEntry[] = Array.from({ length: 8 }, (_, i) => ({
      en: `Iron Ingot ${i}`,
      zh: `铁锭 ${i}`,
      path: `p${i}`,
    }));
    const index = buildTmIndex(entries);
    expect(searchTm(index, "iron ingot")).toHaveLength(5);
    expect(searchTm(index, "iron ingot", { topK: 2 })).toHaveLength(2);
  });

  it("空 query / 空索引返回空数组", () => {
    const index = buildTmIndex(corpus);
    expect(searchTm(index, "")).toEqual([]);
    expect(searchTm(index, "   ")).toEqual([]);
    const empty = buildTmIndex([]);
    expect(searchTm(empty, "crafting")).toEqual([]);
  });
});

describe("fuzzyFind (编辑距离)", () => {
  const corpus: TmEntry[] = [
    { en: "Crafting Table", zh: "工作台", path: "p1" },
    { en: "Crafting Table", zh: "合成台", path: "p2" },
    { en: "Iron Sword", zh: "铁剑", path: "p3" },
    { en: "Sword of Sharpness", zh: "锋利之剑", path: "p4" },
  ];

  it("错拼召回: 词级编辑距离 ≤ maxDist", () => {
    const index = buildTmIndex(corpus);
    const hits = fuzzyFind(index, "tabel"); // table 的错拼
    expect(hits.map((h) => h.en)).toContain("Crafting Table");
    // 距离 1 的候选排在距离 2 之前
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it("整串匹配: 多词查询命中近似整串", () => {
    const index = buildTmIndex(corpus);
    const hits = fuzzyFind(index, "sword of sharps"); // sharpness 的错拼
    expect(hits.map((h) => h.en)).toContain("Sword of Sharpness");
  });

  it("多候选: 同 en 不同 zh 全部返回", () => {
    const index = buildTmIndex(corpus);
    const hits = fuzzyFind(index, "crafting tabl");
    const tableZh = new Set(hits.filter((h) => h.en === "Crafting Table").map((h) => h.zh));
    expect(tableZh).toEqual(new Set(["工作台", "合成台"]));
  });

  it("maxDist 过滤: 距离超过上限不召回", () => {
    const index = buildTmIndex(corpus);
    expect(fuzzyFind(index, "tabl", { maxDist: 1 })).not.toHaveLength(0); // table 缺 1 字符, 距离 1
    expect(fuzzyFind(index, "tabel", { maxDist: 1 })).toEqual([]); // 换位是距离 2
    expect(fuzzyFind(index, "craftin", { maxDist: 0 })).toEqual([]); // 精确才匹配
    expect(fuzzyFind(index, "crafting", { maxDist: 0 }).map((h) => h.en)).toEqual([
      "Crafting Table",
      "Crafting Table",
    ]);
  });

  it("距离升序 + topK", () => {
    const index = buildTmIndex(corpus);
    const hits = fuzzyFind(index, "sword");
    const dists = hits.map((h) => Math.round((1 / h.score - 1) * 100) / 100);
    expect([...dists].sort((a, b) => a - b)).toEqual(dists); // 已按距离升序
    expect(fuzzyFind(index, "sword", { topK: 1 })).toHaveLength(1);
  });

  it("空 query / 空索引返回空数组", () => {
    const index = buildTmIndex(corpus);
    expect(fuzzyFind(index, "")).toEqual([]);
    expect(fuzzyFind(index, "   ")).toEqual([]);
    expect(fuzzyFind(buildTmIndex([]), "tabel")).toEqual([]);
  });
});
