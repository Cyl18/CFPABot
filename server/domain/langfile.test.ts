import { expect, test } from "bun:test";
import {
  detectIndent,
  editJsonValues,
  guessFormat,
  insertJsonKeyAfter,
  normalizeLang,
  parseLang,
  sortLang,
} from "./langfile.ts";

test("tolerant json parse: bom, comments, trailing commas, line numbers", () => {
  const content = [
    "\uFEFF{",
    '  // leading comment',
    '  "a": "1",',
    "  /* block",
    "     comment */",
    '  "b": "2",',
    '  "c": "3",',
    "}",
  ].join("\n");
  const parsed = parseLang(content, "json");
  expect(parsed.errors).toEqual([]);
  expect([...parsed.entries]).toEqual([
    ["a", "1"],
    ["b", "2"],
    ["c", "3"],
  ]);
  expect(parsed.lines.get("a")).toBe(3);
  expect(parsed.lines.get("b")).toBe(6);
  expect(parsed.lines.get("c")).toBe(7);
});

test("tolerant json parse: non-string values keep raw json text", () => {
  const parsed = parseLang('{\n  "n": 12,\n  "o": { "k": 1 },\n  "b": true\n}', "json");
  expect(parsed.entries.get("n")).toBe("12");
  expect(parsed.entries.get("o")).toBe('{"k":1}');
  expect(parsed.entries.get("b")).toBe("true");
});

test("tolerant json parse: duplicate keys last wins, syntax error reported", () => {
  expect(parseLang('{\n  "a": "1",\n  "a": "2"\n}', "json").entries.get("a")).toBe("2");
  const broken = parseLang('{\n  "a": "1"\n', "json");
  expect(broken.errors.length).toBe(1);
  expect(broken.entries.size).toBe(0);
});

test("dot lang parse: comments, first = split, trimmed key, raw value", () => {
  const parsed = parseLang("# comment\n// other\n\ntile.foo = 你好\nitem.bar= x \n", "lang");
  expect([...parsed.entries]).toEqual([
    ["tile.foo", " 你好"],
    ["item.bar", " x "],
  ]);
  expect(parsed.lines.get("tile.foo")).toBe(4);
  expect(parsed.lines.get("item.bar")).toBe(5);
});

test("dot lang parse strips cr and reports missing separator", () => {
  const parsed = parseLang("a=1\r\nb\r\n", "lang");
  expect(parsed.entries.get("a")).toBe("1");
  expect(parsed.errors.length).toBe(1);
});

test("guessFormat", () => {
  expect(guessFormat('{\n  "a": "1"\n}')).toBe("json");
  expect(guessFormat("# hi\na=1\n")).toBe("lang");
});

test("normalizeLang json is two-space and lang follows the ref state machine", () => {
  expect(normalizeLang('{"a":"1","b":"2"}', "json")).toBe('{\n  "a": "1",\n  "b": "2"\n}\n');
  const lang = ["// header", "/* block", "   still comment */", "a=1", "=junk", "b=2"].join("\n");
  expect(normalizeLang(lang, "lang")).toBe(["# header", "# block", "#   still comment ", "a=1", "", "b=2"].join("\n"));
});

test("sortLang keeps detected indent for json and drops lang comments", () => {
  const json = '{\n    "b": "2",\n    "a": "1"\n}';
  expect(sortLang(json, "json")).toBe('{\n    "a": "1",\n    "b": "2"\n}\n');
  expect(sortLang("# c\na=1\n\nb=2\n", "lang")).toBe("a=1\nb=2\n");
});

test("detectIndent", () => {
  expect(detectIndent('{\n    "a": "1"\n}')).toBe("    ");
  expect(detectIndent('{\n\ta=1\n}')).toBe("\t");
});

test("editJsonValues rewrites values in place and counts changes", () => {
  const content = '{\n  "a": "old",\n  "b": "keep",\n  "c": "old"\n}\n';
  const result = editJsonValues(content, (key, value) => (value === "old" ? `新-${key}` : undefined));
  expect(result.changed).toBe(2);
  expect(result.content).toBe('{\n  "a": "新-a",\n  "b": "keep",\n  "c": "新-c"\n}\n');
});

test("editJsonValues escapes quotes and keeps trailing commas", () => {
  const result = editJsonValues('{\n  "a": "x",\n  "b": "y"\n}', () => 'say "hi"');
  expect(result.content).toBe('{\n  "a": "say \\"hi\\"",\n  "b": "say \\"hi\\""\n}');
});

test("insertJsonKeyAfter fixes the comma and keeps indentation", () => {
  const content = '{\n  "a": "1",\n  "b": "2"\n}\n';
  expect(insertJsonKeyAfter(content, "b", "__comment.x.b", "note")).toBe(
    '{\n  "a": "1",\n  "b": "2",\n  "__comment.x.b": "note"\n}\n',
  );
  expect(insertJsonKeyAfter(content, "a", "k", "v")).toBe(
    '{\n  "a": "1",\n  "k": "v",\n  "b": "2"\n}\n',
  );
  expect(insertJsonKeyAfter(content, "missing", "k", "v")).toBeNull();
});
