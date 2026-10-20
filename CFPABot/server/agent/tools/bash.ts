import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolContext } from "../context.ts";
import { localDir } from "../local-store.ts";

const ENV_ALLOW: Record<string, true> = {
  PATH: true,
  HOME: true,
  LANG: true,
  LC_ALL: true,
  TZ: true,
  TERM: true,
  SHELL: true,
  TMPDIR: true,
  TEMP: true,
  TMP: true,
};

/** 子进程只拿白名单环境变量与 PI_* 会话信息，避免把 API key 递给模型写的脚本。 */
function sandboxEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_ALLOW[key] === true || key.startsWith("PI_")) out[key] = value;
  }
  out.HOME = cwd;
  return out;
}

function shellQuote(command: string): string {
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

/** 容器里以 nobody 跑，防止写穿到仓库工作树与会话目录。 */
function dropPrivileges(command: string): string {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return command;
  return `exec setpriv --reuid=65534 --regid=65534 --clear-groups bash -lc ${shellQuote(command)}`;
}

export function bashTool(ctx: ToolContext) {
  return createBashToolDefinition(localDir(ctx.sessionId), {
    spawnHook: (context) => ({
      ...context,
      command: dropPrivileges(context.command),
      env: sandboxEnv(context.env, context.cwd),
    }),
  });
}
