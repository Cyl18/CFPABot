import { describe, expect, test } from "bun:test";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { execBlockReason, scopeGuard } from "./scope-guard.ts";

type Handler = (event: { toolName: string }) => Promise<unknown>;

function install(allowed: boolean): Handler {
  let handler: Handler | undefined;
  const pi = {
    on: (_event: string, fn: Handler) => {
      handler = fn;
    },
  };
  scopeGuard(async () => allowed)(pi as unknown as Parameters<ExtensionFactory>[0]);
  if (!handler) throw new Error("未注册 tool_call 处理器");
  return handler;
}

describe("execBlockReason", () => {
  test("关闭时拒绝 bash 与 eval", () => {
    expect(execBlockReason("bash", false)).toContain("evalScope=off");
    expect(execBlockReason("eval", false)).toContain("evalScope=off");
  });

  test("开启时放行", () => {
    expect(execBlockReason("bash", true)).toBeUndefined();
    expect(execBlockReason("eval", true)).toBeUndefined();
  });

  test("其它工具不受影响", () => {
    expect(execBlockReason("read", false)).toBeUndefined();
  });
});

describe("scopeGuard", () => {
  test("tool_call 处返回 block", async () => {
    const denied = await install(false)({ toolName: "bash" });
    expect(denied).toMatchObject({ block: true });
  });

  test("开启时不干预", async () => {
    expect(await install(true)({ toolName: "eval" })).toBeUndefined();
  });
});
