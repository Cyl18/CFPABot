import { describe, expect, test } from "bun:test";
import type { WriteScope } from "../../shared/api.ts";
import type { ToolContext } from "./context.ts";
import { assertCanWrite } from "./policy.ts";

function ctxOf(writeScope: WriteScope): ToolContext {
  return {
    sessionId: "test",
    writeScope,
    local: async () => null,
    saveLocal: async () => ({ content: "", updatedAt: "" }),
    listLocal: async () => [],
  };
}

describe("assertCanWrite", () => {
  test("off 拒绝一切写入", () => {
    expect(() => assertCanWrite(ctxOf("off"))).toThrow("writeScope=off");
  });

  test("on 允许写入", () => {
    expect(() => assertCanWrite(ctxOf("on"))).not.toThrow();
  });
});
