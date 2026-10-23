import type { WriteScope } from "@cfpa/contracts/api";

export type { WriteScope } from "@cfpa/contracts/api";

/** 写 GitHub 需要的会话信息；scheme handler 从会话文件反查得到。 */
export interface WriteSession {
  sessionId: string;
  writeScope: WriteScope;
}

// 默认 off：一次误调用不能把评论发到公开仓库。
export function assertCanWrite(session: WriteSession): void {
  if (session.writeScope === "off") {
    throw new Error("写权限未开启：本会话 writeScope=off。管理员可在会话上开启 on。");
  }
}
