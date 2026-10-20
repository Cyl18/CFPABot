import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { ToolContext } from "../context.ts";
import { editResource } from "../resources/index.ts";

const EDIT_PARAMS = type({
  path: type("string").describe("pr:// 评论或 local:// 文件"),
  old_string: type("string").describe("要替换的原文，必须能被找到"),
  new_string: type("string").describe("替换后的文本"),
  "replace_all?": type("boolean").describe("出现多次时是否全部替换"),
});

export function editTool(ctx: ToolContext): AgentTool<typeof EDIT_PARAMS> {
  return {
    name: "edit",
    label: "编辑资源",
    description: "编辑 pr:// 评论或 local:// 文本；用法见 help://tools/edit。",
    parameters: EDIT_PARAMS,
    execute: async (toolCallId, params) =>
      editResource(params.path, params.old_string, params.new_string, params.replace_all === true, ctx, toolCallId),
  };
}
