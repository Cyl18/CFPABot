import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext } from "../context.ts";
import { writeResource } from "../resources/index.ts";

const WRITE_PARAMS = Type.Object({
  path: Type.String({ description: "资源 URI：repo:// 或 local://" }),
  content: Type.Optional(Type.String({ description: "评论正文、review/submit 或线程状态 JSON、本地文件全文" })),
});

export function writeTool(ctx: ToolContext): AgentTool<typeof WRITE_PARAMS> {
  return {
    name: "write",
    label: "写入资源",
    description:
      "写入资源：repo:// 直接写 GitHub（评论、行内评论、线程状态、线程回复、发布审查、提交待审评论），受 writeScope 限制；local:// 覆盖本会话短名文件。",
    parameters: WRITE_PARAMS,
    execute: async (toolCallId, params) => writeResource(params.path, params.content, ctx, toolCallId),
  };
}
