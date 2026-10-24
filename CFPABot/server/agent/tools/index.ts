import type { ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ToolContext } from "../context.ts";
import { bashTool } from "./bash.ts";
import { delegateTool } from "./delegate.ts";

export function buildTools(ctx: ToolContext, extensions: ExtensionFactory[] = []): ToolDefinition[] {
  const tools = [bashTool(ctx), delegateTool(ctx, (childCtx) => buildTools(childCtx), extensions)];
  // 内置工具的泛型比 ToolDefinition 的默认参数更窄，运行时同构。
  return tools as ToolDefinition[];
}
