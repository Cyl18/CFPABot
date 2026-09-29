import { describe, expect, test } from "bun:test";
import { parseLines, permissionDecision, splitArgs } from "./commands-parse.ts";

describe("splitArgs", () => {
  test("按空格切分", () => {
    expect(splitArgs("a b c")).toEqual(["a", "b", "c"]);
  });

  test("双引号内的空格不切分", () => {
    expect(splitArgs('"a b" c')).toEqual(["a b", "c"]);
  });

  test("单引号内的空格不切分", () => {
    expect(splitArgs("'a b' c")).toEqual(["a b", "c"]);
  });

  test("连续空格不产生空参数", () => {
    expect(splitArgs("a   b")).toEqual(["a", "b"]);
  });

  test("引号内可嵌套另一种引号", () => {
    expect(splitArgs('"it\'s" x')).toEqual(["it's", "x"]);
  });

  test("空输入", () => {
    expect(splitArgs("")).toEqual([]);
  });
});

describe("parseLines", () => {
  test("跳过非命令行", () => {
    expect(parseLines("hello\nworld")).toEqual([]);
  });

  test("无斜杠开头的行被忽略，命令仍被保留", () => {
    expect(parseLines("hello\n/revert")).toEqual([{ name: "revert", args: [], rest: "" }]);
  });

  test("CRLF 分隔的多行命令", () => {
    expect(parseLines("/revert\r\n/mv a b")).toEqual([
      { name: "revert", args: [], rest: "" },
      { name: "mv", args: ["a", "b"], rest: "a b" },
    ]);
  });

  test("无参数命令", () => {
    expect(parseLines("/revert")).toEqual([{ name: "revert", args: [], rest: "" }]);
  });

  test("保留原始参数文本", () => {
    expect(parseLines('/mv "projects/a b" dest')[0]?.rest).toBe('"projects/a b" dest');
  });

  test("引号参数", () => {
    expect(parseLines('/mv "projects/a b" dest')[0]?.args).toEqual(["projects/a b", "dest"]);
  });

  test("前导空格的行不是命令", () => {
    expect(parseLines(" /mv a b")).toEqual([]);
  });
});

describe("permissionDecision", () => {
  test("协作者放行", () => {
    expect(permissionDecision({ isCollaborator: true, isPrAuthor: false, headOwnerIsAuthor: false })).toBe("allow");
  });

  test("非作者非协作者拒绝", () => {
    expect(permissionDecision({ isCollaborator: false, isPrAuthor: false, headOwnerIsAuthor: false })).toBe("denied");
  });

  test("作者且 head 仓库属于自己放行", () => {
    expect(permissionDecision({ isCollaborator: false, isPrAuthor: true, headOwnerIsAuthor: true })).toBe("allow");
  });

  test("作者但 head 仓库不属于自己拒绝", () => {
    expect(permissionDecision({ isCollaborator: false, isPrAuthor: true, headOwnerIsAuthor: false })).toBe("owner-denied");
  });
});
