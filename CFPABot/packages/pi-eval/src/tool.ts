import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runEval, type EvalFiles } from "./eval.ts";

const EVAL_PARAMS = Type.Object({
  language: Type.Union([Type.Literal("py"), Type.Literal("js"), Type.Literal("bash")]),
  code: Type.String({ description: "要执行的代码；容器内无网络、无项目密钥。" }),
  timeout: Type.Optional(Type.Number({ description: "超时秒数，默认 60，最大 300" })),
  stdin: Type.Optional(
    Type.String({ description: "标准输入文本；以 local:// 开头时读取本地文件" }),
  ),
  inputs: Type.Optional(
    Type.Array(Type.String(), { description: "local:// 文件，挂到 /workspace/in 只读使用" }),
  ),
  outputs: Type.Optional(
    Type.Array(Type.String(), { description: "把 /workspace/out 下的这些文件保存回 local://" }),
  ),
});

export function evalTool(config: { image: string }): ToolDefinition<typeof EVAL_PARAMS> {
  return {
    name: "eval",
    label: "执行代码",
    description:
      "在一次性 Docker 沙箱执行 py/js/bash；stdin 支持文本或 local://，inputs 挂到 /workspace/in，outputs 写回会话 local/。",
    parameters: EVAL_PARAMS,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) => {
      const file = ctx.sessionManager.getSessionFile();
      const dir = join(file ? dirname(file) : ctx.sessionManager.getSessionDir(), "local");
      const files: EvalFiles = {
        read: async (name) => {
          try {
            return await readFile(join(dir, name), "utf8");
          } catch {
            return null;
          }
        },
        write: async (name, content) => {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, name), content, "utf8");
        },
      };
      const result = await runEval(
        {
          language: params.language,
          code: params.code,
          ...(params.timeout === undefined ? {} : { timeoutMs: params.timeout * 1000 }),
          ...(params.stdin === undefined ? {} : { stdin: params.stdin }),
          ...(params.inputs === undefined ? {} : { inputs: params.inputs }),
          ...(params.outputs === undefined ? {} : { outputs: params.outputs }),
        },
        files,
        config,
        signal,
      );
      const value = { ok: result.exitCode === 0, ...result };
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  };
}
