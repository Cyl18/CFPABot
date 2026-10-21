import { describe, expect, test } from "bun:test";
import { parseUri, uriSegments } from "./uri.ts";

describe("parseUri", () => {
  test("repo 文件路径与行范围", () => {
    const uri = parseUri("repo://projects/assets/foo/1.20/bar/lang/zh_cn.json:10-20");
    expect(uri.scheme).toBe("repo");
    expect(uri.path).toBe("projects/assets/foo/1.20/bar/lang/zh_cn.json");
    expect(uri.scheme === "help" ? undefined : uri.selector).toEqual({ from: 10, to: 20 });
    expect(uri.query.size).toBe(0);
  });

  test("repo 查询参数保留", () => {
    const uri = parseUri("repo://projects/x/zh_cn.json?ref=abc");
    expect(uri.path).toBe("projects/x/zh_cn.json");
    expect(uri.query.get("ref")).toBe("abc");
  });

  test("pr 编号从首段剥离", () => {
    const uri = parseUri("pr://42/files/projects/x/zh_cn.json:1-3?side=head");
    expect(uri.scheme).toBe("pr");
    if (uri.scheme !== "pr") throw new Error("scheme");
    expect(uri.number).toBe(42);
    expect(uri.path).toBe("files/projects/x/zh_cn.json");
    expect(uri.selector).toEqual({ from: 1, to: 3 });
    expect(uri.query.get("side")).toBe("head");
  });

  test("pr 根路径", () => {
    const uri = parseUri("pr://7");
    expect(uri.scheme).toBe("pr");
    expect(uri.path).toBe("");
  });

  test("pr 缺少编号报错", () => {
    expect(() => parseUri("pr://files/a.json")).toThrow("需要 PR 编号");
  });

  test("gh 资源", () => {
    const uri = parseUri("gh://issues/12/comments");
    expect(uri.scheme).toBe("gh");
    expect(uri.path).toBe("issues/12/comments");
  });

  test("query 中的编码路径还原", () => {
    const uri = parseUri("pr://1/special-files/content?key=guide%2F_zh_cn%2Fx.md");
    expect(uri.query.get("key")).toBe("guide/_zh_cn/x.md");
  });

  test("local 子目录与行范围", () => {
    const uri = parseUri("local://src/draft.json:3-9");
    expect(uri.scheme).toBe("local");
    expect(uri.path).toBe("src/draft.json");
    expect(uri.scheme === "help" ? undefined : uri.selector).toEqual({ from: 3, to: 9 });
  });

  test("local 根路径用于列出文件", () => {
    expect(parseUri("local://").path).toBe("");
  });

  test("skill 路径与行范围", () => {
    const uri = parseUri("skill://review:1-5");
    expect(uri.scheme).toBe("skill");
    expect(uri.path).toBe("review");
    expect(uri.scheme === "help" ? undefined : uri.selector).toEqual({ from: 1, to: 5 });
  });

  test("文件名里的冒号用 %3A 转义，不会被当成 selector", () => {
    const uri = parseUri("repo://notes%3A12");
    expect(uri.path).toBe("notes:12");
    expect(uri.scheme === "help" ? undefined : uri.selector).toBeUndefined();
  });

  test("help 路径没有 selector", () => {
    const uri = parseUri("help://tools/read");
    expect(uri.scheme).toBe("help");
    expect(uri.path).toBe("tools/read");
    expect("selector" in uri).toBe(false);
  });

  test("uriSegments 拆路径", () => {
    expect(uriSegments(parseUri("pr://3/review/rows"))).toEqual(["review", "rows"]);
  });

  test("非支持 scheme 报错", () => {
    expect(() => parseUri("file:///etc/passwd")).toThrow("不支持的 scheme");
  });
});
