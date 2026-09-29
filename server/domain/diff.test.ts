import { expect, test } from "bun:test";
import { compareLang, compareTwo, crossVersion, inHunks, patchAddedLines, patchHunks } from "./diff.ts";
import { parseLang } from "./langfile.ts";

test("compareLang orders head-en keys first then the rest sorted", () => {
  const base = {
    en: parseLang('{"z": "1", "m": "1", "gone": "1"}', "json"),
    zh: parseLang('{"z": "1", "m": "1"}', "json"),
  };
  const head = {
    en: parseLang('{"b": "2", "z": "1", "m": "1"}', "json"),
    zh: parseLang('{"b": "2", "z": "1", "m": "1", "orphan": "x"}', "json"),
  };
  const rows = compareLang(base, head);
  expect(rows.map((r) => r.key)).toEqual(["b", "z", "m", "gone", "orphan"]);
  expect(rows.map((r) => [r.enStatus, r.zhStatus])).toEqual([
    ["add", "add"],
    ["same", "same"],
    ["same", "same"],
    ["remove", "same"],
    ["same", "add"],
  ]);
  const first = rows[0];
  expect(first?.baseEn).toBeUndefined();
  expect(first?.headEn).toBe("2");
});

test("compareLang tolerates null sides", () => {
  const rows = compareLang({}, { en: parseLang('{"a": "1"}', "json"), zh: null });
  expect(rows).toEqual([
    { key: "a", headEn: "1", enStatus: "add", zhStatus: "same" },
  ]);
});

test("compareTwo reports add/remove/modify/same", () => {
  const rows = compareTwo(new Map([["a", "1"], ["b", "1"]]), new Map([["b", "2"], ["c", "3"]]));
  expect(rows).toEqual([
    { key: "a", left: "1", status: "remove" },
    { key: "b", left: "1", right: "2", status: "modify" },
    { key: "c", right: "3", status: "add" },
  ]);
});

test("crossVersion builds a consistency matrix", () => {
  const rows = crossVersion([
    { version: "1.19", en: new Map([["k", "Stone"]]), zh: new Map([["k", "石头"]]) },
    { version: "1.20", en: new Map([["k", "Stone"]]), zh: new Map([["k", "石块"]]) },
    { version: "1.21", en: new Map([["k", "Stone"]]), zh: new Map() },
  ]);
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(row?.enConsistent).toBe(true);
  expect(row?.zhConsistent).toBe(false);
  expect(row?.cells["1.21"]).toEqual({ en: "Stone" });
  expect(row?.cells["1.19"]).toEqual({ en: "Stone", zh: "石头" });
});

test("patchHunks and patchAddedLines read the new side", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " keep",
    "-drop",
    "+added one",
    "+added two",
    " tail",
    "@@ -10,2 +12,1 @@ section",
    "-x",
    "+added three",
  ].join("\n");
  expect(patchHunks(patch)).toEqual([
    { start: 1, end: 4 },
    { start: 12, end: 12 },
  ]);
  expect(patchAddedLines(patch)).toEqual([
    { line: 2, text: "added one" },
    { line: 3, text: "added two" },
    { line: 12, text: "added three" },
  ]);
  expect(inHunks(4, patchHunks(patch))).toBe(true);
  expect(inHunks(11, patchHunks(patch))).toBe(false);
});
