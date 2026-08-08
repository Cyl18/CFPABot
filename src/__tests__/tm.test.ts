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
  queryTm,
  getExactMap,
  freqPenalty,
  thresholdToSimilarity,
  shortQueryMaxDist,
  levenshtein,
  tokenize,
  type TmEntry,
  type TmIndex,
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

  it("错拼召回: 1-edit 错拼(≤8 字符查询)仍可召回", () => {
    const index = buildTmIndex(corpus);
    const hits = fuzzyFind(index, "craftin"); // crafting 缺 1 字符
    expect(hits.map((h) => h.en)).toContain("Crafting Table");
    // 距离 1 的候选排在距离 2 之前
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it("短查询收紧: ≤8 字符拒绝 2-edit 换位错拼", () => {
    const index = buildTmIndex(corpus);
    expect(fuzzyFind(index, "tabel")).toEqual([]); // tabel↔table 是 2-edit 换位, 短串拒绝
    expect(fuzzyFind(index, "tabl")).not.toHaveLength(0); // 1-edit(缺字符)保留
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

  it("距离升序(分数降序) + topK", () => {
    const index = buildTmIndex(corpus);
    const hits = fuzzyFind(index, "sword");
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores); // 已按分数降序(=距离升序)
    expect(fuzzyFind(index, "sword", { topK: 1 })).toHaveLength(1);
  });

  it("空 query / 空索引返回空数组", () => {
    const index = buildTmIndex(corpus);
    expect(fuzzyFind(index, "")).toEqual([]);
    expect(fuzzyFind(index, "   ")).toEqual([]);
    expect(fuzzyFind(buildTmIndex([]), "tabel")).toEqual([]);
  });
});

describe("exact 哈希索引", () => {
  const corpus: TmEntry[] = [
    { en: "Crafting Table", zh: "工作台", path: "p1", key: "tile.table" },
    { en: "Crafting Table", zh: "合成台", path: "p2", key: "tile.table" },
    { en: "Iron Sword", zh: "铁剑", path: "p3", key: "item.sword" },
  ];

  it("buildTmIndex 构建 en(小写) → docId 映射", () => {
    const index = buildTmIndex(corpus);
    const exact = index.exact ?? {};
    expect(exact["crafting table"]).toHaveLength(2);
    expect(exact["iron sword"]).toEqual([2]);
    expect(exact["IRON SWORD"]).toBeUndefined(); // 键恒为小写
  });

  it("getExactMap 对旧版索引(无 exact 字段)惰性回填", () => {
    const index = buildTmIndex(corpus);
    const legacy: TmIndex = {
      docs: index.docs,
      df: index.df,
      postings: index.postings,
      avgDocLen: index.avgDocLen,
      totalDocs: index.totalDocs,
      k1: index.k1,
      b: index.b,
      // 无 exact — 模拟旧版落盘文件
    };
    const map = getExactMap(legacy);
    expect(map["crafting table"]).toHaveLength(2);
    const built = index.exact ?? {};
    expect(getExactMap(index)).toBe(built); // 已有 exact 直接返回
  });

  it("key 溯源字段保留首个出现值", () => {
    const index = buildTmIndex(corpus);
    expect(index.docs[0]!.key).toBe("tile.table");
  });
});

describe("freqPenalty / thresholdToSimilarity / shortQueryMaxDist", () => {
  it("freqPenalty: 高频无折扣, 低频降权", () => {
    expect(freqPenalty(5)).toBe(1);
    expect(freqPenalty(2)).toBe(0.95);
    expect(freqPenalty(1)).toBe(0.9);
  });

  it("thresholdToSimilarity: 非线性映射 10→0.70, 80→0.96, 100→1.0", () => {
    expect(thresholdToSimilarity(10)).toBeCloseTo(0.7, 1);
    expect(thresholdToSimilarity(80)).toBeCloseTo(0.96, 2);
    expect(thresholdToSimilarity(100)).toBeCloseTo(1.0, 2);
    expect(thresholdToSimilarity(0)).toBe(0);
    expect(thresholdToSimilarity(150)).toBe(1); // clamp
    expect(thresholdToSimilarity(-5)).toBe(0);
  });

  it("shortQueryMaxDist: ≤8 字符收紧到 1-edit, 9+ 保持默认", () => {
    expect(shortQueryMaxDist(8, 2)).toBe(1);
    expect(shortQueryMaxDist(3, 2)).toBe(1);
    expect(shortQueryMaxDist(9, 2)).toBe(2);
    expect(shortQueryMaxDist(20, 2)).toBe(2);
    expect(shortQueryMaxDist(5, 0)).toBe(0); // 显式更严上限不被放宽
  });
});

describe("queryTm (统一入口: 先精确后模糊)", () => {
  const corpus: TmEntry[] = [
    { en: "Crafting Table", zh: "工作台", path: "p1" },
    { en: "Crafting Table", zh: "合成台", path: "p2" },
    { en: "Crafting", zh: "合成", path: "p3" },
    { en: "Iron Sword", zh: "铁剑", path: "p4" },
    { en: "Diamond Sword", zh: "钻石剑", path: "p5" },
  ];
  const index = buildTmIndex(corpus);

  it("精确命中(忽略大小写)置于 exact 并标记", () => {
    const res = queryTm(index, "CRAFTING TABLE");
    expect(res.exact.map((h) => h.zh)).toEqual(["工作台", "合成台"]); // 多译法全保留, 按 freq 降序
    expect(res.exact.every((h) => h.exact === true)).toBe(true);
    expect(res.exact[0]!.score).toBe(1 * freqPenalty(1));
  });

  it("模糊命中排除精确已覆盖条目", () => {
    const res = queryTm(index, "crafting table");
    expect(res.fuzzy.some((h) => h.en === "Crafting Table")).toBe(false); // 精确已覆盖
    expect(res.fuzzy.map((h) => h.en)).toContain("Crafting"); // 部分命中仍在
  });

  it("all = exact + fuzzy, exact 优先", () => {
    const res = queryTm(index, "crafting table");
    expect(res.all[0]!.exact).toBe(true);
    expect(res.all[0]!.en).toBe("Crafting Table");
  });

  it("minScore 只过滤 fuzzyFind 命中, 不作用于 BM25", () => {
    // 错拼查询: BM25 无命中("craftin" 不在倒排表), fuzzyFind dist=1 命中 score≈0.45
    const resStrict = queryTm(index, "craftin", { minScore: 0.9 });
    expect(resStrict.fuzzy).toEqual([]); // fuzzyFind 相似度低于阈值, 全被过滤
    const resLenient = queryTm(index, "craftin", { minScore: 0.3 });
    expect(resLenient.fuzzy.length).toBeGreaterThan(0); // 低阈值放行错拼召回
    expect(resLenient.fuzzy.every((h) => h.score >= 0.3)).toBe(true);
    // BM25 量纲无界, 不受相似度阈值影响: 高阈值下双词 BM25 命中仍保留
    const resBm25 = queryTm(index, "crafting table", { minScore: thresholdToSimilarity(80) });
    expect(resBm25.fuzzy.length).toBeGreaterThan(0);
  });

  it("无精确命中时退化为纯模糊检索", () => {
    const res = queryTm(index, "zombie pigman");
    expect(res.exact).toEqual([]);
    expect(res.fuzzy).toEqual([]);
    const res2 = queryTm(index, "iron");
    expect(res2.exact).toEqual([]);
    expect(res2.fuzzy.length).toBeGreaterThan(0); // BM25 词元命中
  });

  it("旧索引(无 exact 字段)仍可正常检索", () => {
    const legacy: TmIndex = {
      docs: index.docs,
      df: index.df,
      postings: index.postings,
      avgDocLen: index.avgDocLen,
      totalDocs: index.totalDocs,
      k1: index.k1,
      b: index.b,
    };
    const res = queryTm(legacy, "crafting table");
    expect(res.exact.map((h) => h.zh)).toEqual(["工作台", "合成台"]);
  });

  it("空 query / 空索引返回空结果", () => {
    expect(queryTm(index, "")).toEqual({ exact: [], fuzzy: [], all: [] });
    expect(queryTm(buildTmIndex([]), "crafting").all).toEqual([]);
  });
});
