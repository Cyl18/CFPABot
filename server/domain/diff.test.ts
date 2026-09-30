import { expect, test } from "bun:test";
import { alignKeys, compareLang, compareTwo, inHunks, patchAddedLines, patchHunks } from "./diff.ts";
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

test("alignKeys lists every key with a cell per version that has it", () => {
  const rows = alignKeys([
    { version: "1.19", en: new Map([["a", "Stone"], ["b", "Dirt"]]), zh: new Map([["a", "石头"]]) },
    { version: "1.20", en: new Map([["a", "Stone"], ["b", ""]]), zh: new Map([["a", "石块"]]), touched: new Set(["a"]) },
    { version: "1.21", en: new Map([["c", "Sand"]]), zh: new Map([["c", "沙子"]]) },
  ]);
  expect(rows).toEqual([
    {
      key: "a",
      touched: true,
      cells: [
        { version: "1.19", en: "Stone", zh: "石头" },
        { version: "1.20", en: "Stone", zh: "石块" },
      ],
    },
    {
      key: "b",
      touched: false,
      cells: [{ version: "1.19", en: "Dirt", zh: null }],
    },
    {
      key: "c",
      touched: false,
      cells: [{ version: "1.21", en: "Sand", zh: "沙子" }],
    },
  ]);
});

test("literal and real newlines compare equal in compareLang, compareTwo and alignKeys", () => {
  const langSide = parseLang("a=a\\nb", "lang");
  const jsonSide = parseLang('{"a": "a\\nb"}', "json");
  expect(compareLang({ en: langSide }, { en: jsonSide })).toEqual([
    { key: "a", baseEn: "a\\nb", headEn: "a\\nb", enStatus: "same", zhStatus: "same" },
  ]);

  expect(compareTwo(new Map([["a", "a\\nb"]]), new Map([["a", "a\nb"]]))).toEqual([
    { key: "a", left: "a\\nb", right: "a\\nb", status: "same" },
  ]);

  expect(
    alignKeys([
      { version: "1.19", en: new Map([["a", "a\\nb"]]), zh: new Map([["a", "甲\\n乙"]]) },
      { version: "1.20", en: new Map([["a", "a\nb"]]), zh: new Map([["a", "甲\n乙"]]) },
    ]),
  ).toEqual([
    {
      key: "a",
      touched: false,
      cells: [
        { version: "1.19", en: "a\\nb", zh: "甲\\n乙" },
        { version: "1.20", en: "a\\nb", zh: "甲\\n乙" },
      ],
    },
  ]);
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
