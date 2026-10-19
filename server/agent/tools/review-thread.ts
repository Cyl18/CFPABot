import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { serverGraphql } from "../../github/client.ts";
import { setThreadResolved } from "../../github/review.ts";
import type { ToolContext } from "../context.ts";
import { assertCanWrite } from "../policy.ts";
import { jsonResult } from "./shared.ts";

const THREAD_PARAMS = Type.Object({
  threadId: Type.String({ description: "review thread id" }),
  resolved: Type.Boolean({ description: "true 标记已解决，false 重新打开" }),
  prNumber: Type.Optional(Type.Number({ description: "会话未绑定 PR 且 writeScope=any 时必填" })),
});

export function reviewThreadResolveTool(ctx: ToolContext): AgentTool<typeof THREAD_PARAMS> {
  return {
    name: "review_thread_resolve",
    label: "标记线程状态",
    description: "已解决/重新打开一条 review thread。",
    parameters: THREAD_PARAMS,
    execute: async (_toolCallId, params) => {
      const n = params.prNumber ?? ctx.prNumber;
      if (n === null) throw new Error("缺少 PR 编号。");
      assertCanWrite(ctx, n);
      await setThreadResolved(serverGraphql, params.threadId, params.resolved);
      return jsonResult({ ok: true });
    },
  };
}
