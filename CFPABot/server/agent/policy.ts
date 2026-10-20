import type { ToolContext } from "./context.ts";

export type { WriteScope } from "../../shared/api.ts";

// 默认 off：一次误调用不能把评论发到公开仓库。
export function assertCanWrite(ctx: ToolContext): void {
  if (ctx.writeScope === "off") {
    throw new Error("写权限未开启：本会话 writeScope=off。管理员可在会话上开启 on。");
  }
}
