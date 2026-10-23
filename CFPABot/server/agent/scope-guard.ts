import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { WriteScope } from "@cfpa/contracts/api";

const EXEC_TOOLS: Record<string, true> = { bash: true, eval: true };
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };
const LOCAL_URI = /^local:\/\//i;
const PR_URI = /^pr:\/\//i;

/** 工具始终注册，关闭执行权限时在调用处拒绝，工具块因此恒定。 */
export function execBlockReason(toolName: string, allowed: boolean): string | undefined {
  if (EXEC_TOOLS[toolName] !== true || allowed) return undefined;
  return "执行权限已关闭（evalScope=off），管理员可在会话上开启。";
}

/** local:// 永远可写；GitHub 写入跟 writeScope 走；其余路径一律拒绝。 */
export function writeBlockReason(toolName: string, input: unknown, scope: WriteScope): string | undefined {
  if (WRITE_TOOLS[toolName] !== true) return undefined;
  const path = input && typeof input === "object" && "path" in input ? input.path : undefined;
  if (typeof path !== "string" || path.length === 0) return "写入需要明确的 local:// 或 pr:// 目标。";
  if (LOCAL_URI.test(path)) return undefined;
  if (PR_URI.test(path)) {
    return scope === "on" ? undefined : "写权限未开启（writeScope=off），管理员可在会话上开启。";
  }
  return "只能写 local://（会话 workspace）或 pr://（GitHub）。";
}

export function scopeGuard(execAllowed: () => Promise<boolean>, writeScopeOf: () => Promise<WriteScope>): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const execReason = execBlockReason(event.toolName, await execAllowed());
      const writeReason =
        execReason === undefined ? writeBlockReason(event.toolName, event.input, await writeScopeOf()) : undefined;
      const reason = execReason ?? writeReason;
      return reason === undefined ? undefined : { block: true, reason };
    });
  };
}
