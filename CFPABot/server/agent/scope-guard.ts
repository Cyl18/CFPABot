import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";

const EXEC_TOOLS: Record<string, true> = { bash: true, eval: true };

/** 工具始终注册，关闭执行权限时在调用处拒绝，工具块因此恒定。 */
export function execBlockReason(toolName: string, allowed: boolean): string | undefined {
  if (EXEC_TOOLS[toolName] !== true || allowed) return undefined;
  return "执行权限已关闭（evalScope=off），管理员可在会话上开启。";
}

export function scopeGuard(execAllowed: () => Promise<boolean>): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const reason = execBlockReason(event.toolName, await execAllowed());
      return reason === undefined ? undefined : { block: true, reason };
    });
  };
}
