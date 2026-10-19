import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext } from "../context.ts";
import { runEval } from "../eval/index.ts";
import { jsonResult } from "../result.ts";

const EVAL_PARAMS = Type.Object({
  language: Type.Union([Type.Literal("py"), Type.Literal("js"), Type.Literal("bash")]),
  code: Type.String({ description: "要执行的代码；容器内无网络、无项目密钥。" }),
  timeout: Type.Optional(Type.Number({ description: "超时秒数，默认 60，最大 300" })),
  inputs: Type.Optional(
    Type.Array(Type.String(), { description: "local:// 文件，挂到 /workspace/in 只读使用" }),
  ),
});

export function evalTool(ctx: ToolContext): AgentTool<typeof EVAL_PARAMS> {
  return {
    name: "eval",
    label: "执行代码",
    description:
      "在一次性沙箱容器里执行 Python / JavaScript / Bash，用来编排 QA 规则和数据处理。会话需要 evalScope=run。",
    parameters: EVAL_PARAMS,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const result = await runEval(
        {
          language: params.language,
          code: params.code,
          ...(params.timeout === undefined ? {} : { timeoutMs: params.timeout * 1000 }),
          ...(params.inputs === undefined ? {} : { inputs: params.inputs }),
        },
        ctx,
        signal,
      );
      return jsonResult({ ok: result.exitCode === 0, ...result });
    },
  };
}
