import { describe, expect, test } from "bun:test";
import type { EvalScope } from "../../shared/api.ts";
import type { ToolContext } from "./context.ts";
import { runEval } from "./eval/index.ts";

function ctxOf(evalScope: EvalScope): ToolContext {
  return {
    sessionId: "test",
    prNumber: null,
    baseSha: null,
    headSha: null,
    writeScope: "off",
    evalScope,
    local: async () => null,
    saveLocal: async () => ({ content: "", updatedAt: "" }),
    listLocal: async () => [],
    packFor: async () => null,
    savePackFor: async () => {},
  };
}

describe("eval 权限与预算", () => {
  test("evalScope=off 拒绝执行", async () => {
    await expect(runEval({ language: "bash", code: "echo hi" }, ctxOf("off"))).rejects.toThrow("evalScope=off");
  });

  test("空代码与超长代码在启动容器前拒绝", async () => {
    await expect(runEval({ language: "py", code: "  " }, ctxOf("run"))).rejects.toThrow("code 不能为空");
    await expect(runEval({ language: "py", code: "x".repeat(65 * 1024) }, ctxOf("run"))).rejects.toThrow("64 KiB");
  });

  test("输入只接受已存在的 local 文件", async () => {
    await expect(runEval({ language: "py", code: "print(1)", inputs: ["repo://x"] }, ctxOf("run"))).rejects.toThrow(
      "只支持 local://",
    );
    await expect(
      runEval({ language: "py", code: "print(1)", inputs: ["local://missing.txt"] }, ctxOf("run")),
    ).rejects.toThrow("本地文件不存在");
  });
});
