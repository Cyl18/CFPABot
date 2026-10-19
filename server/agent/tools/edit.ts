import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext } from "../context.ts";
import { editResource } from "../resources/index.ts";

const EDIT_PARAMS = Type.Object({
  path: Type.String({ description: "repo:// 评论或 local:// 文件" }),
  old_string: Type.String({ description: "要替换的原文，必须能被找到" }),
  new_string: Type.String({ description: "替换后的文本" }),
  replace_all: Type.Optional(Type.Boolean({ description: "出现多次时是否全部替换" })),
});

export function editTool(ctx: ToolContext): AgentTool<typeof EDIT_PARAMS> {
  return {
    name: "edit",
    label: "编辑资源",
    description: "编辑资源文本：替换 repo:// 中机器人自己的评论正文，或 local:// 会话文件中的文本。",
    parameters: EDIT_PARAMS,
    execute: async (toolCallId, params) =>
      editResource(params.path, params.old_string, params.new_string, params.replace_all === true, ctx, toolCallId),
  };
}
