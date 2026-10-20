import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { ToolContext } from "../context.ts";
import { readResource } from "../resources/index.ts";

const READ_PARAMS = type({
  path: type("string").describe("资源 URI：repo://、pr://、gh://、local://、skill:// 或 help://；行范围用 :N-M"),
});

export function readTool(ctx: ToolContext): AgentTool<typeof READ_PARAMS> {
  return {
    name: "read",
    label: "读取资源",
    description: "读取 repo://、pr://、gh://、local://、skill:// 或 help:// 资源；完整用法见 help://tools/read。",
    parameters: READ_PARAMS,
    execute: async (_toolCallId, params) => readResource(params.path, ctx),
  };
}
