// src/__tests__/term-match.test.ts
// term-match 行级术语匹配：hash 短语 / regex scope / version scope / ok 判定。

import { describe, expect, test } from "bun:test";
import { buildTermMatcher, matchRowTerms, versionAtLeast } from "../flows/_shared/terminology/term-match.js";

describe("buildTermMatcher + matchRowTerms", () => {
  test("非 regex 短语 hash 匹配：行 en 含术语 → 命中 + 遵守判定", () => {
    const m = buildTermMatcher(
      [{ word: "Stonecutter", text: "切石机", source: "internal" }],
      [{ en: ["Advanced tooltips"], zh: ["高级提示框"] }],
    );
    const hits = matchRowTerms(m, "item.m.key", "Advanced tooltips: Stonecutter recipe", "高级提示框：切石机配方");
    expect(hits.map((h) => `${h.source}:${h.en}`).sort()).toEqual([
      "internal:Stonecutter",
      "vanilla:Advanced tooltips",
    ]);
    expect(hits.every((h) => h.ok)).toBe(true);
  });

  test("术语匹配失败：zh 不含术语 zh → ok=false", () => {
    const m = buildTermMatcher([{ word: "Stonecutter", text: "切石机", source: "internal" }], []);
    const hits = matchRowTerms(m, "item.m.key", "Stonecutter", "石匠台");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ok).toBe(false);
  });

  test("regex key scope：逐条匹配，key 不命中则不算", () => {
    const m = buildTermMatcher([], [{ en: ["Angler"], zh: ["垂钓纹样"], scope: { key: "pottery" } }]);
    expect(matchRowTerms(m, "block.pottery.angler", "Angler", "垂钓纹样")).toHaveLength(1);
    expect(matchRowTerms(m, "entity.fish.angler", "Angler", "垂钓纹样")).toHaveLength(0);
  });

  test("version scope：版本门槛生效", () => {
    const m = buildTermMatcher([], [{ en: ["Armorer"], zh: ["盔甲商"], scope: { version: "1.12.2" } }]);
    expect(matchRowTerms(m, "projects/1.20.1/assets/x/zh_cn.json", "Armorer", "盔甲商")).toHaveLength(1);
    expect(matchRowTerms(m, "projects/1.12.2/assets/x/zh_cn.json", "Armorer", "盔甲商")).toHaveLength(1);
    expect(matchRowTerms(m, "projects/1.7.10/assets/x/zh_cn.json", "Armorer", "盔甲商")).toHaveLength(0);
  });

  test("multi-zh：任一译名遵守即 ok", () => {
    const m = buildTermMatcher([], [{ en: ["Acacia"], zh: ["金合欢木", "金合欢"] }]);
    expect(matchRowTerms(m, "item.m.key", "Acacia wood", "金合欢木板")[0]!.ok).toBe(true);
  });

  test("多词短语窗口：词序列匹配，非子串乱配", () => {
    const m = buildTermMatcher([], [{ en: ["Base Gradient"], zh: ["自下渐淡"] }]);
    expect(matchRowTerms(m, "item.m.key", "Base", "自下渐淡")).toHaveLength(0);
    expect(matchRowTerms(m, "item.m.key", "Gradient Base", "自下渐淡")).toHaveLength(0);
    expect(matchRowTerms(m, "item.m.key", "Base Gradient banner", "自下渐淡旗帜")).toHaveLength(1);
  });

  test("versionAtLeast 比较", () => {
    expect(versionAtLeast("1.20.1", "1.12.2")).toBe(true);
    expect(versionAtLeast("1.12.2", "1.12.2")).toBe(true);
    expect(versionAtLeast("1.7.10", "1.12.2")).toBe(false);
    expect(versionAtLeast("26.2", "1.20.1")).toBe(true);
  });
});
