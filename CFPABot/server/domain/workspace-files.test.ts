import { describe, expect, test } from "bun:test";
import { pickLocale } from "@cfpa/review-core/domain/workspace-files";

const FILES = [
  "projects/assets/demo/1.21/bees/lang/en_us.json",
  "projects/assets/demo/1.21/genetics/lang/en_us.json",
];

describe("pickLocale 只认工作区自己的文件", () => {
  test("同一 PR 有多个 namespace 时按 key 取文件", () => {
    const picked = pickLocale({ slug: "demo", version: "1.21", namespace: "genetics", files: FILES }, "en_us");
    expect(picked?.path).toBe("projects/assets/demo/1.21/genetics/lang/en_us.json");
  });

  test("本 namespace 没有该 locale 时返回 null，不退到兄弟 namespace", () => {
    const picked = pickLocale({ slug: "demo", version: "1.21", namespace: "genetics", files: FILES }, "zh_cn");
    expect(picked).toBeNull();
  });
});
