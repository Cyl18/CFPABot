import { describe, expect, test } from "bun:test";
import { parseUri } from "./uri.ts";

describe("parseUri", () => {
  test("基础路径没有 selector", () => {
    const uri = parseUri("repo://pr/1");
    expect(uri.path).toBe("pr/1");
    expect(uri.selector).toBeUndefined();
    expect(uri.query.size).toBe(0);
  });

  test("长文件路径与行范围 selector", () => {
    const uri = parseUri("repo://pr/1/files/projects/assets/foo/1.20/bar/lang/zh_cn.json:10-20");
    expect(uri.path).toBe("pr/1/files/projects/assets/foo/1.20/bar/lang/zh_cn.json");
    expect(uri.selector).toEqual({ from: 10, to: 20 });
  });

  test("查询参数保留", () => {
    const uri = parseUri("repo://files/projects/x/zh_cn.json?ref=abc");
    expect(uri.path).toBe("files/projects/x/zh_cn.json");
    expect(uri.query.get("ref")).toBe("abc");
  });

  test("query 中的编码路径还原", () => {
    const uri = parseUri("repo://pr/1/special/content?key=guide%2F_zh_cn%2Fx.md");
    expect(uri.query.get("key")).toBe("guide/_zh_cn/x.md");
  });

  test("local 短名与行范围", () => {
    const uri = parseUri("local://draft.json:3-9");
    expect(uri.scheme).toBe("local");
    expect(uri.path).toBe("draft.json");
    expect(uri.selector).toEqual({ from: 3, to: 9 });
  });

  test("local 根路径用于列出文件", () => {
    expect(parseUri("local://").path).toBe("");
  });

  test("非支持 scheme 报错", () => {
    expect(() => parseUri("gh://pr/1")).toThrow("不支持的 scheme");
  });
});
