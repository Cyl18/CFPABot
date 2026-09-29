import { expect, test } from "bun:test";
import type { PrFile } from "../../shared/api.ts";
import { duplicateZh, entryFindings, fileFindings, keyParity, pathChecks, typoCheck } from "./checks.ts";
import type { TypoRule } from "./checks.ts";
import { parseLang } from "./langfile.ts";

function file(path: string, status: PrFile["status"] = "modified"): PrFile {
  return { path, status, additions: 1, deletions: 0 };
}

test("pathChecks flags patchouli_book, uppercase, deleted and stray lang files", () => {
  expect(pathChecks([file("projects/assets/foo/1.20/bar/patchouli_book/en_us.json")]).map((i) => i.code)).toEqual([
    "patchouli_book",
  ]);
  expect(pathChecks([file("projects/assets/foo/1.20/Bar/lang/zh_cn.json")]).map((i) => i.code)).toEqual([
    "uppercase_path",
  ]);
  expect(
    pathChecks([file("projects/1.12.2/assets/actuallyadditions/actuallyadditions/lang/zh_CN.lang")]).map((i) => i.code),
  ).toEqual([]);
  expect(
    pathChecks([
      file("projects/assets/foo/1.20/bar/lang/zh_cn.json", "removed"),
      file("projects/assets/foo/1.20/bar/lang/zh_cn.json"),
    ]).map((i) => i.code),
  ).toEqual(["deleted_lang"]);
  expect(pathChecks([file("foo/lang/zh_cn.json")]).map((i) => i.code)).toEqual(["bad_path", "stray_lang"]);
});

test("pathChecks describes broken submission paths", () => {
  const items = pathChecks([
    file("projects/1.20/lang/zh_cn.json"),
    file("projects/assets/zh_cn/1.20/bar"),
    file("projects/assets/foo/1.20/lang/zh_cn.json"),
    file("projects/assets/foo/1.20/baz/zh_cn.json"),
  ]);
  expect(items.map((i) => i.code)).toEqual(["bad_path", "bad_path", "bad_path", "bad_path"]);
  expect(items[0]?.message).toContain("请检查提交路径：`projects/1.20/lang/zh_cn.json`");
  expect(items[1]?.message).toContain("缺少了 {ModDomain} 和 lang 文件夹");
  expect(items[2]?.message).toContain("缺少了 {ModDomain} 或 {CurseForge 项目名} 文件夹");
  expect(items[3]?.message).toContain("缺少了 lang 文件夹");
});

test("pathChecks flags illegal characters only in lang paths", () => {
  const items = pathChecks([file("projects/assets/foo/1.20/bar lang/lang/zh_cn.json")]);
  expect(items.map((i) => i.code)).toEqual(["illegal_path"]);
  expect(items[0]?.message).toContain("检测到了可能不合规的路径");
});

test("keyParity ignores underscore keys and lists up to three examples with line numbers", () => {
  const en = parseLang('{\n  "a": "1",\n  "_hidden": "1",\n  "b": "1",\n  "c": "1",\n  "d": "1"\n}', "json");
  const zh = parseLang('{\n  "a": "1",\n  "_hidden": "x",\n  "e": "1"\n}', "json");
  const items = keyParity("foo/1.20/bar", en, zh);
  expect(items.length).toBe(1);
  const item = items[0];
  expect(item?.level).toBe("warn");
  expect(item?.code).toBe("key_parity");
  expect(item?.message).toContain("- 英文有 3 个 Key 多于中文。例如：");
  expect(item?.message).toContain("  - 行 4-`b`");
  expect(item?.message).toContain("  - 行 5-`c`");
  expect(item?.message).toContain("  - 行 6-`d`");
  expect(item?.message).toContain("- 中文有 1 个 Key 多于英文。例如：");
  expect(item?.message).toContain("  - 行 4-`e`");
});

test("keyParity reports ok when keys match and errors on syntax problems", () => {
  const en = parseLang('{"a": "1"}', "json");
  const zh = parseLang('{"a": "2"}', "json");
  expect(keyParity("x", en, zh)).toEqual([
    { level: "ok", code: "key_parity", message: "ℹ x 中英文 Key 相互对应。" },
  ]);
  const broken = keyParity("x", parseLang('{"a": "1"', "json"), zh);
  expect(broken.length).toBe(1);
  expect(broken[0]?.level).toBe("error");
  expect(broken[0]?.code).toBe("json_syntax");
});

const RULES: TypoRule[] = [
  { term: "萤石", message: "请注意区分`荧石`与`萤石`", level: "warn" },
  { term: "地狱", message: "`地狱`在 1.16 后更名为`下界`", level: "warn", skipLegacy: true },
  { term: "錾制", message: "在 1.19.2 后更名为`雕纹`", level: "warn", minVersion: "1.19" },
  { term: "岩浆", message: "可能是`熔岩`", level: "warn", unless: ["岩浆块", "岩浆怪", "岩浆膏"] },
  { term: "浅灰色", message: "原版译名采用`淡灰色`", level: "error" },
];

test("typoCheck reports each term once globally and honours predicates", () => {
  const items = typoCheck(
    [
      { path: "p1", line: 1, text: 'a: "萤石粉"', version: "1.20" },
      { path: "p2", line: 2, text: 'b: "萤石"', version: "1.20" },
      { path: "p3", line: 3, text: 'c: "地狱岩"', version: "1.12.2" },
      { path: "p4", line: 4, text: 'd: "地狱"', version: "1.20" },
      { path: "p5", line: 5, text: 'e: "錾制石砖"', version: "1.12.2" },
      { path: "p6", line: 6, text: 'f: "岩浆块"', version: "1.20" },
      { path: "p7", line: 7, text: 'g: "浅灰色染料"', version: "1.20" },
    ],
    RULES,
  );
  expect(items.map((i) => [i.code, i.level, i.path])).toEqual([
    ["typo", "warn", "p1"],
    ["typo", "warn", "p4"],
    ["typo", "error", "p7"],
  ]);
  expect(items[0]?.message).toBe("ℹ 可能争议译名：`萤石`，请注意区分`荧石`与`萤石`。例如 `a: \"萤石粉\"`。");
});

test("typoCheck shortens long values around the term", () => {
  const items = typoCheck(
    [
      {
        path: "p",
        line: 1,
        text: 'k: "前前后后前前后后前前后后前前后后前前后后前前后后前前后后浅灰色后后"',
        version: "1.20",
      },
    ],
    [{ term: "浅灰色", message: "m", level: "error" }],
  );
  expect(items[0]?.message).toContain("例如 `k:");
  expect(items[0]?.message).toContain("浅灰色");
});

test("entryFindings placeholder direction follows the JVM rule", () => {
  expect(entryFindings("k", "%s", "%s")).toEqual([]);
  expect(entryFindings("k", "%s", "%s %s").map((f) => [f.code, f.hint])).toEqual([
    ["placeholder_mismatch", "critical"],
  ]);
  expect(entryFindings("k", "%s %s", "%s").map((f) => [f.code, f.hint])).toEqual([
    ["placeholder_mismatch", "neutral"],
  ]);
  expect(entryFindings("k", "%s %d", "%d %s").map((f) => [f.code, f.hint])).toEqual([
    ["placeholder_mismatch", "major"],
  ]);
});

test("entryFindings covers empty, untranslated, units and stale", () => {
  expect(entryFindings("k", "Stone", "")).toEqual([{ code: "empty_value", hint: "minor", detail: "空翻译值" }]);
  expect(entryFindings("block.shader.name.x", "abc", "abc").map((f) => [f.code, f.hint])).toEqual([
    ["untranslated_value", "neutral"],
  ]);
  expect(entryFindings("k", "Plain", "Plain").map((f) => [f.code, f.hint])).toEqual([
    ["untranslated_value", "minor"],
  ]);
  expect(entryFindings("k", "500 mB of energy", "500 mB of energy").map((f) => [f.code, f.hint])).toEqual([
    ["units_kept", "neutral"],
  ]);
  expect(entryFindings("k", "Stone", "石头", { en: "Stone", zh: "石头" })).toEqual([]);
  expect(entryFindings("k", "Stones", "石头", { en: "Stone", zh: "石头" }).map((f) => [f.code, f.hint])).toEqual([
    ["stale_translation", "major"],
  ]);
});

test("fileFindings reports eof newline and mixed indent", () => {
  expect(fileFindings("a\n")).toEqual([]);
  expect(fileFindings("a").map((f) => f.code)).toEqual(["no_trailing_newline"]);
  expect(fileFindings("\ta\n  b\n").map((f) => f.code)).toEqual(["mixed_indent"]);
});

test("duplicateZh groups only differing english", () => {
  const dup = duplicateZh([
    { key: "block.a", en: "Stone", zh: "石头" },
    { key: "item.a", en: "Rock", zh: "石头" },
    { key: "block.b", en: "Same", zh: "相同" },
    { key: "item.b", en: "Same", zh: "相同" },
    { key: "block.c", en: "X", zh: "" },
  ]);
  expect([...dup]).toEqual([["石头", ["block.a", "item.a"]]]);
});
