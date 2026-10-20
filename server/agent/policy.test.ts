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
    expect(() => assertCanWrite(ctxOf("off", 1))).toThrow("writeScope=off");
  });

  test("on 允许任意 PR", () => {
    expect(() => assertCanWrite(ctxOf("on", null))).not.toThrow();
  });
});
