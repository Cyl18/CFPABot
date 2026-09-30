import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildTermIndex, loadTermIndex, lookupTerm, matchQa, matchTerms } from "./terms.ts";

const row = (cells: string[]): string => cells.join("\t");

const FILES: Record<string, string> = {
  "terms-v1.tsv": [row(["en", "zh", "reason", "comment"]), row(["Ancient", "远古", "", ""]), row(["Ancient Debris", "远古残骸", "", ""]), row(["Creeper", "苦力怕", "", ""])].join("\n"),
  "terms-version.tsv": [row(["versions", "en", "zh", "reason", "comment"]), row(["1.12.2", "Creeper", "爬行者", "", ""])].join("\n"),
  "special/terms-banner.tsv": [row(["en", "zh", "reason", "comment"]), row(["Base", "底座", "", ""])].join("\n"),
  "qa-rules.tsv": [
    row(["id", "key", "except_key", "en", "require", "forbid", "mode", "except_en", "comment"]),
    row(["count-x", "", "", "X", "甲", "", "count", "", ""]),
    row(["bool-y", "", "", "Y", "乙", "", "string", "Y-Skip", ""]),
  ].join("\n"),
};

test("matchTerms takes the longest phrase and consumes its tokens", () => {
  const index = buildTermIndex(FILES);
  const hits = matchTerms(index, "item.a", "Ancient Debris", "远古残骸");
  expect(hits.map((h) => [h.en, h.ok])).toEqual([["Ancient Debris", true]]);
  const partial = matchTerms(index, "item.a", "Ancient City", "远古城市");
  expect(partial.map((h) => [h.en, h.ok])).toEqual([["Ancient", true]]);
  const miss = matchTerms(index, "item.a", "Ancient", "古代");
  expect(miss.map((h) => [h.en, h.ok])).toEqual([["Ancient", false]]);
});

test("matchTerms scopes special tables by key substring", () => {
  const index = buildTermIndex(FILES);
  expect(matchTerms(index, "block.minecraft.banner.base", "Base", "底座").map((h) => [h.en, h.domain])).toEqual([
    ["Base", "banner"],
  ]);
  expect(matchTerms(index, "block.minecraft.base", "Base", "底座")).toEqual([]);
});

test("matchTerms requires an exact version for versioned terms and prefers them", () => {
  const index = buildTermIndex(FILES);
  expect(matchTerms(index, "entity.Creeper.name", "Creeper", "爬行者", "1.12.2").map((h) => [h.en, h.ok])).toEqual([
    ["Creeper", true],
  ]);
  expect(matchTerms(index, "entity.Creeper.name", "Creeper", "苦力怕", "1.20").map((h) => [h.en, h.ok])).toEqual([
    ["Creeper", true],
  ]);
});

test("matchTerms skips versioned phrases without a version", () => {
  const index = buildTermIndex({ "terms-version.tsv": FILES["terms-version.tsv"] as string });
  expect(matchTerms(index, "entity.Creeper.name", "Creeper", "爬行者", "1.12.2").map((h) => h.en)).toEqual([
    "Creeper",
  ]);
  expect(matchTerms(index, "entity.Creeper.name", "Creeper", "爬行者")).toEqual([]);
  expect(matchTerms(index, "entity.Creeper.name", "Creeper", "爬行者", "1.16.5")).toEqual([]);
});

test("matchQa honours count mode, gates and forbid", () => {
  const index = buildTermIndex(FILES);
  expect(matchQa(index, "k", "X X", "甲甲")).toEqual([{ id: "count-x", ok: true, require: "甲" }]);
  expect(matchQa(index, "k", "X X", "甲")).toEqual([{ id: "count-x", ok: false, require: "甲" }]);
  expect(matchQa(index, "k", "Y", "乙")).toEqual([{ id: "bool-y", ok: true, require: "乙" }]);
  expect(matchQa(index, "k", "Y-Skip", "乙")).toEqual([]);
});

test("lookupTerm ranks exact matches first", () => {
  const index = buildTermIndex(FILES);
  expect(lookupTerm(index, "creeper", 5).map((t) => t.en)).toEqual(["Creeper"]);
  expect(lookupTerm(index, "远古", 5).map((t) => t.en)).toEqual(["Ancient", "Ancient Debris"]);
  expect(lookupTerm(index, "nothing-here", 5)).toEqual([]);
});

test("matchTerms matches phrases containing punctuation like apostrophes", async () => {
  const dir = join(import.meta.dir, "../../config/vanilla-terms");
  const index = await loadTermIndex(dir);
  expect(matchTerms(index, "item.minecraft.dragon_breath", "Dragon's Breath", "龙息").map((h) => [h.en, h.ok])).toEqual([
    ["Dragon's Breath", true],
  ]);
  expect(matchTerms(index, "block.minecraft.jack_o_lantern", "Jack o'Lantern", "南瓜灯").map((h) => [h.en, h.ok])).toEqual([
    ["Jack o'Lantern", true],
  ]);
});

test("loadTermIndex reads the vendored TSVs and is mtime cached", async () => {
  const dir = join(import.meta.dir, "../../config/vanilla-terms");
  const index = await loadTermIndex(dir);
  expect(matchTerms(index, "block.minecraft.stone", "Stone", "石头").map((h) => [h.en, h.ok])).toEqual([
    ["Stone", true],
  ]);
  expect(matchTerms(index, "block.minecraft.ancient_debris", "Ancient Debris", "残骸").map((h) => [h.en, h.ok])).toEqual([
    ["Ancient Debris", false],
  ]);
  expect(matchQa(index, "block.minecraft.deepslate_iron_ore", "Deepslate Iron Ore", "深层铁矿石")).toEqual([
    { id: "deepslate-ore", ok: true, require: "深层", comment: "Deepslate 后最多 3 词再 Ore，次数对深层" },
  ]);
  expect(await loadTermIndex(dir)).toBe(index);
});
