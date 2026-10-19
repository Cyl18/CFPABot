import { describe, expect, test } from "bun:test";
import type { WriteScope } from "../../shared/api.ts";
import type { ToolContext } from "./context.ts";
import { assertCanWrite } from "./policy.ts";

function ctxOf(writeScope: WriteScope, prNumber: number | null): ToolContext {
  return {
    sessionId: "test",
    prNumber,
    baseSha: null,
    headSha: null,
    writeScope,
    evalScope: "off",
    local: async () => null,
    saveLocal: async () => ({ content: "", updatedAt: "" }),
    listLocal: async () => [],
    packFor: async () => null,
    savePackFor: async () => {},
  };
}

describe("assertCanWrite", () => {
  test("off 拒绝一切写入", () => {
    expect(() => assertCanWrite(ctxOf("off", 1), 1)).toThrow("writeScope=off");
  });

  test("bound 允许写绑定的 PR", () => {
    expect(() => assertCanWrite(ctxOf("bound", 1), 1)).not.toThrow();
  });

  test("bound 拒绝写其它 PR", () => {
    expect(() => assertCanWrite(ctxOf("bound", 1), 2)).toThrow("只能写 PR #1");
  });

  test("bound 未绑定 PR 时不生效", () => {
    expect(() => assertCanWrite(ctxOf("bound", null), 1)).toThrow("未绑定 PR");
  });

  test("any 允许任意 PR", () => {
    expect(() => assertCanWrite(ctxOf("any", null), 9)).not.toThrow();
  });
});
