import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolContext } from "../context.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { glossaryTool } from "./glossary.ts";
import { readTool } from "./read.ts";
import { findTool, grepTool, lsTool } from "./search.ts";
import { writeTool } from "./write.ts";

export function buildTools(ctx: ToolContext): ToolDefinition[] {
  const tools = [
    readTool(ctx),
    writeTool(ctx),
    editTool(ctx),
    grepTool(ctx),
    findTool(ctx),
    lsTool(ctx),
    glossaryTool(),
    ...(ctx.evalScope === "run" ? [bashTool(ctx)] : []),
  ];
  // 内置工具的泛型比 ToolDefinition 的默认参数更窄，运行时同构。
  return tools as ToolDefinition[];
}
