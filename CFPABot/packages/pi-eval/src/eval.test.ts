import { describe, expect, test } from "bun:test";
import { runEval, type EvalFiles } from "./eval.ts";

const files: EvalFiles = {
  read: async (name) => (name === "exists.txt" ? "hello" : null),
  write: async () => {},
};

const options = { image: "cfpa-eval:latest" };

describe("eval 输入预算", () => {
  test("空代码与超长代码在启动容器前拒绝", async () => {
    await expect(runEval({ language: "py", code: "  " }, files, options)).rejects.toThrow("code 不能为空");
    await expect(runEval({ language: "py", code: "x".repeat(65 * 1024) }, files, options)).rejects.toThrow("64 KiB");
  });

  test("输入只接受已存在的 local 文件", async () => {
    await expect(runEval({ language: "py", code: "print(1)", inputs: ["repo://x"] }, files, options)).rejects.toThrow(
      "只支持 local://",
    );
    await expect(
      runEval({ language: "py", code: "print(1)", inputs: ["local://missing.txt"] }, files, options),
    ).rejects.toThrow("本地文件不存在");
  });

  test("输出名在启动容器前校验", async () => {
    await expect(
      runEval({ language: "py", code: "print(1)", outputs: ["bad/name"] }, files, options),
    ).rejects.toThrow("输出文件名无效");
  });
});
