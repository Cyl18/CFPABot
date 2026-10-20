import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { ToolContext } from "../context.ts";
import { writeResource } from "../resources/index.ts";

const WRITE_PARAMS = type({
  path: type("string").describe("资源 URI：pr:// 或 local://"),
  "content?": type("string").describe("评论正文、review/submit 或线程状态 JSON、本地文件全文"),
});

export function writeTool(ctx: ToolContext): AgentTool<typeof WRITE_PARAMS> {
  return {
    name: "write",
    label: "写入资源",
    description: "写入 pr:// 或 local://；权限与可用路径见 help://tools/write。",
    parameters: WRITE_PARAMS,
    execute: async (toolCallId, params) => writeResource(params.path, params.content, ctx, toolCallId),
  };
}
