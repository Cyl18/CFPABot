// src/__tests__/ngram.test.ts
// PURE n-gram 术语候选提取测试(自动术语表语料)。
// 覆盖: 跨条目频次统计、minFreq/minLen/maxTerms 过滤、n=1/2/3、
// 大小写归一、zh 占比最高翻译选择、确定性排序。

import { describe, it, expect } from "bun:test";
import {
  extractNgramTerms,
  type NgramLangEntry,
} from "../flows/_shared/terminology/ngram.js";

function entry(
  en: string,
  zh: string,
  version = "1.20.1",
  domain = "testmod",
): NgramLangEntry {
  return {
    en,
    zh,
    path: `projects/assets/testmod/${version}/${domain}/lang/zh_cn.json`,
    version,
    domain,
  };
}

describe("extractNgramTerms", () => {
  it("提取跨条目重复出现的 n-gram, freq 为出现条目数", () => {
    const terms = extractNgramTerms([
      entry("Craft an Iron Ingot from iron ore.", "用铁矿石合成铁锭。"),
      entry("Iron Ingot is used in many recipes.", "铁锭用于许多配方。"),
      entry("A wooden stick is cheap.", "木棍很便宜。"),
    ]);

    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({
      word: "Iron Ingot",
      freq: 2,
      text: "用铁矿石合成铁锭。",
    });
    expect(terms[0]!.note).toContain("2 个条目");
  });

  it("freq 按出现条目数统计(3 条中 2 条含该 n-gram → freq 2)", () => {
    const terms = extractNgramTerms([
      entry("Iron ingot crafting recipe.", "铁锭配方。"),
      entry("Iron ingot is heavy.", "铁锭很重。"),
      entry("Gold nugget is shiny.", "金粒闪闪发光。"),
    ]);

    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ word: "Iron ingot", freq: 2 });
  });

  it("minFreq 过滤: 只出现在 1 个条目的 n-gram 默认被排除", () => {
    const terms = extractNgramTerms([
      entry("Iron ingot recipe.", "铁锭配方。"),
      entry("Gold nugget recipe.", "金粒配方。"),
    ]);

    expect(terms).toHaveLength(0);

    // minFreq=1 时全部保留(含仅出现在 1 个条目的 bigram)
    const relaxed = extractNgramTerms(
      [
        entry("Iron ingot recipe.", "铁锭配方。"),
        entry("Gold nugget recipe.", "金粒配方。"),
      ],
      { minFreq: 1 },
    );
    expect(relaxed).toHaveLength(4);
    expect(relaxed.map((t) => t.word).sort()).toEqual([
      "Gold nugget",
      "Iron ingot",
      "ingot recipe",
      "nugget recipe",
    ]);
  });

  it("同条目内重复出现只计 1(跨条目才统计)", () => {
    const terms = extractNgramTerms([
      entry("Iron Iron Iron Ingot.", "铁铁铁锭。"),
      entry("Iron ore.", "铁矿石。"),
    ]);

    // "iron ingot" 只出现在条目 1 → freq 1,默认 minFreq=2 被排除
    expect(terms).toHaveLength(0);

    const relaxed = extractNgramTerms(
      [
        entry("Iron Iron Iron Ingot.", "铁铁铁锭。"),
        entry("Iron ore.", "铁矿石。"),
      ],
      { minFreq: 1 },
    );
    // "iron ingot" freq=1(条目去重), "iron" freq=2
    const ironIngot = relaxed.find((t) => t.word === "Iron Ingot");
    expect(ironIngot).toMatchObject({ freq: 1 });
  });

  it("n=1 提取单 token, 大小写归一且 word 取多数形式", () => {
    const terms = extractNgramTerms(
      [
        entry("Iron Ingot and iron ore.", "铁锭和铁矿石。"),
        entry("iron is a metal.", "铁是一种金属。"),
      ],
      { n: 1 },
    );

    const iron = terms.find((t) => t.word === "Iron" || t.word === "iron");
    expect(iron).toBeDefined();
    expect(iron!.freq).toBe(2);
    // 形式计数: "Iron"×1(条目1), "iron"×2(条目1+条目2) → 取多数形式
    expect(iron!.word).toBe("iron");
  });

  it("n=3 提取 trigram", () => {
    const terms = extractNgramTerms(
      [
        entry("Craft an iron ingot recipe.", "制作铁锭配方。"),
        entry("Read an iron ingot guide.", "阅读铁锭指南。"),
      ],
      { n: 3 },
    );

    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({
      word: "an iron ingot",
      freq: 2,
    });
  });

  it("text 取出现条目中占比最高的 zh 翻译", () => {
    const terms = extractNgramTerms([
      entry("Iron Ingot item.", "铁锭物品。"),
      entry("Iron Ingot is heavy.", "铁锭很重。"),
      entry("Iron Ingot recipe.", "铁锭物品。"),
    ]);

    expect(terms[0]).toMatchObject({
      word: "Iron Ingot",
      freq: 3,
      text: "铁锭物品。",
    });
  });

  it("minLen 过滤短 token(如 a/of)", () => {
    const defaultMin = extractNgramTerms(
      [
        entry("a iron ingot.", "铁锭。"),
        entry("a iron pickaxe.", "铁镐。"),
      ],
      { minFreq: 1 },
    );

    // "a" 长度 1 < minLen=2 被过滤; 含 "a" 的 bigram 也不存在
    expect(defaultMin.map((t) => t.word)).toEqual([
      "iron ingot",
      "iron pickaxe",
    ]);

    const relaxed = extractNgramTerms(
      [
        entry("a iron ingot.", "铁锭。"),
        entry("a iron pickaxe.", "铁镐。"),
      ],
      { n: 1, minLen: 1, minFreq: 1 },
    );
    const aTerm = relaxed.find((t) => t.word === "a");
    expect(aTerm).toMatchObject({ freq: 2 });
  });

  it("maxTerms 截断返回数量", () => {
    const terms = extractNgramTerms(
      [
        entry("alpha beta gamma delta.", "翻译一。"),
        entry("alpha beta gamma delta.", "翻译二。"),
        entry("alpha beta gamma delta.", "翻译三。"),
        entry("alpha beta gamma delta.", "翻译四。"),
      ],
      { n: 1, maxTerms: 2 },
    );

    expect(terms).toHaveLength(2);
  });

  it("结果按 freq 降序、word 升序排列(确定性)", () => {
    const terms = extractNgramTerms(
      [
        entry("alpha zeta.", "译一。"),
        entry("alpha zeta.", "译二。"),
        entry("alpha zeta.", "译三。"),
        entry("beta omega.", "译四。"),
        entry("beta omega.", "译五。"),
        entry("beta omega.", "译六。"),
        entry("beta omega.", "译七。"),
      ],
      { n: 1 },
    );

    expect(terms.map((t) => t.word)).toEqual(["beta", "omega", "alpha", "zeta"]);
    expect(terms[0]!.freq).toBeGreaterThan(terms[2]!.freq);
  });

  it("空输入返回空数组", () => {
    expect(extractNgramTerms([])).toEqual([]);
  });

  it("空 en 文本的条目被跳过", () => {
    const terms = extractNgramTerms([
      entry("", "空翻译。"),
      entry("Iron Ingot.", "铁锭。"),
      entry("Iron Ingot again.", "铁锭。"),
    ]);

    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ word: "Iron Ingot", freq: 2 });
  });

  it("按标点切词: 逗号/句号/连字符视为分隔", () => {
    const terms = extractNgramTerms(
      [
        entry("Iron,Ingot;night-vision", "铁锭,夜视。"),
        entry("Iron Ingot night vision", "铁锭夜视。"),
      ],
      { n: 1 },
    );

    const words = terms.map((t) => t.word);
    expect(words).toContain("Iron");
    expect(words).toContain("Ingot");
    expect(words).toContain("night");
    expect(words).toContain("vision");
    expect(terms.every((t) => t.freq === 2)).toBe(true);
  });
});
