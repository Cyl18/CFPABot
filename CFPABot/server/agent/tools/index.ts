import type { CustomTool, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { ToolContext } from "../context.ts";
import { logger } from "../../log.ts";
import { bashTool } from "./bash.ts";
import { delegateTool } from "./delegate.ts";

const log = logger("agent-tools");

// 模型只看到错误文本；工具名、参数与堆栈留在服务端日志里，排障不用再猜。
function logged<T extends CustomTool>(tool: T): T {
  const run = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (...args: Parameters<CustomTool["execute"]>) => {
      try {
        return await run(...args);
      } catch (err) {
        log.error("工具执行失败", { tool: tool.name, args: args[1], err });
        throw err;
      }
    },
  };
}

export function buildTools(
  ctx: ToolContext,
  availableTools: string[],
  extensions: ExtensionFactory[] = [],
): CustomTool[] {
  return [logged(bashTool(ctx, availableTools)), logged(delegateTool(ctx, extensions))];
}
