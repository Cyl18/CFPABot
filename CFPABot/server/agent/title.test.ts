import { describe, expect, test } from "bun:test";
import { cleanTitle, fallbackTitle } from "./title.ts";

describe("fallbackTitle", () => {
  test("取首行并折叠空白", () => {
    expect(fallbackTitle("审查 PR #6162\n\n重点关注物品名")).toBe("审查 PR #6162");
  });

  test("去掉尾部标点并限长", () => {
    expect(fallbackTitle("帮我检查一下这个模组的所有物品名称！")).toBe("帮我检查一下这个模组的所有物品名称");
    expect(fallbackTitle("长".repeat(40))).toHaveLength(24);
  });

  test("空消息回退到新会话", () => {
    expect(fallbackTitle("  \n ")).toBe("新会话");
  });
});

describe("cleanTitle", () => {
  test("去掉引号与结尾标点", () => {
    expect(cleanTitle("「审查 PR #6162」")).toBe("审查 PR #6162");
    expect(cleanTitle("“物品名检查”。")).toBe("物品名检查");
  });

  test("取第一行非空内容", () => {
    expect(cleanTitle("\n 标题\n第二行")).toBe("标题");
  });
});
