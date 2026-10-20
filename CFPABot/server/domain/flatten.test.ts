import { describe, expect, test } from "bun:test";
import { parseFlatten, specialFormat } from "./flatten.ts";

function parsedOf(text: string) {
  const parsed = parseFlatten(text);
  if (parsed === null) throw new Error("解析失败");
  return parsed;
}

describe("parseFlatten", () => {
  test("展平：空 key 归并父级、前缀以 :_-/ 结尾直接拼接、其余用点连接", () => {
    const parsed = parsedOf(
      ['{ "a.b": { "": "1", c: "2", "d": { e: "3" } },', '  "x:": { y: "4" }, "m-": { n: "5" }, "p/": { q: "6" }, }'].join("\n"),
    );
    expect([...parsed.entries]).toEqual([
      ["a.b", "1"],
      ["a.b.c", "2"],
      ["a.b.d.e", "3"],
      ["x:y", "4"],
      ["m-n", "5"],
      ["p/q", "6"],
    ]);
  });

  test("字符串转义与续行", () => {
    const parsed = parsedOf('{ a: "x\\ny", b: \'it\\\'s\', c: "\\u2192", d: "p\\\n   q", e: "\\\\" }');
    expect(parsed.entries.get("a")).toBe("x\ny");
    expect(parsed.entries.get("b")).toBe("it's");
    expect(parsed.entries.get("c")).toBe("\u2192");
    expect(parsed.entries.get("d")).toBe("p   q");
    expect(parsed.entries.get("e")).toBe("\\");
  });

  test("行号：叶 key 所在行（1 起），注释与续行不串行", () => {
    const parsed = parsedOf(
      ["// 开头注释", "{", "  a: {", "    b: 'v',", "  },", "  /* 多行", "     注释 */ c: 'w',", "}"].join("\n"),
    );
    expect(parsed.lines.get("a.b")).toBe(4);
    expect(parsed.lines.get("c")).toBe(7);
  });

  test("整数样式的 key 保持文档顺序", () => {
    const parsed = parsedOf('{ "2": "a", "1": "b", "10": "c", x: "d" }');
    expect([...parsed.entries.keys()]).toEqual(["2", "1", "10", "x"]);
  });

  test("非字符串叶值走 JSON.stringify", () => {
    const parsed = parsedOf('{ n: 1.5, t: true, z: null, arr: [1, "a", { k: "v" }], e: [], h: 0x1F, s: [1,,2] }');
    expect(parsed.entries.get("n")).toBe("1.5");
    expect(parsed.entries.get("t")).toBe("true");
    expect(parsed.entries.get("z")).toBe("null");
    expect(parsed.entries.get("arr")).toBe('[1,"a",{"k":"v"}]');
    expect(parsed.entries.get("e")).toBe("[]");
    expect(parsed.entries.get("h")).toBe("31");
    expect(parsed.entries.get("s")).toBe("[1,null,2]");
  });

  test("重复展平 key：后出现的胜出（值与行号）", () => {
    const parsed = parsedOf("{\n  a: 'x',\n  a: 'y',\n}");
    expect(parsed.entries.get("a")).toBe("y");
    expect(parsed.lines.get("a")).toBe(3);
  });

  test("语法错误返回 null", () => {
    expect(parseFlatten('{ a: "x }')).toBeNull();
    expect(parseFlatten("{ a 1 }")).toBeNull();
    expect(parseFlatten("[1]")).toBeNull();
    expect(parseFlatten("{ a: 1 } x")).toBeNull();
    expect(parseFlatten("{ a: nope }")).toBeNull();
    expect(parseFlatten("{ a: 1 ")).toBeNull();
    expect(parseFlatten("{, a: 1 }")).toBeNull();
    expect(parseFlatten("{ a: 1,, b: 2 }")).toBeNull();
    expect(parseFlatten("{ a: 1 b: 2 }")).toBeNull();
  });
});

describe("specialFormat", () => {
  test("按文件名识别格式", () => {
    expect(specialFormat("projects/assets/m/1.20/m/lang/en_us.flatten.json5")).toBe("flatten");
    expect(specialFormat("projects/assets/m/1.20/m/lang/en_us.json")).toBeNull();
  });
});
