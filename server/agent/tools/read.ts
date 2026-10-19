import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext } from "../context.ts";
import { readResource } from "../resources/index.ts";

const READ_PARAMS = Type.Object({
  path: Type.String({ description: "资源 URI：repo:// 或 local://；行范围用 :N-M" }),
});

export function readTool(ctx: ToolContext): AgentTool<typeof READ_PARAMS> {
  return {
    name: "read",
    label: "读取资源",
    description:
      "读取资源：repo://（PR 元数据、变更文件、讨论、审查行、特殊文件、跨版本 key）或 local://（本会话短名文本）。行范围用 :N-M。",
    parameters: READ_PARAMS,
    execute: async (_toolCallId, params) => readResource(params.path, ctx),
  };
}
