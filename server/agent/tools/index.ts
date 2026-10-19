import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../context.ts";
import { editTool } from "./edit.ts";
import { evalTool } from "./eval.ts";
import { glossaryTool } from "./glossary.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export function buildTools(ctx: ToolContext): AgentTool[] {
  return [
    readTool(ctx),
    writeTool(ctx),
    editTool(ctx),
    evalTool(ctx),
    glossaryTool(),
  ];
}
