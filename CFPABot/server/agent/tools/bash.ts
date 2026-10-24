import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { type } from "@oh-my-pi/omptype";
import type { ToolContext } from "../context.ts";
import { localDir } from "../local-store.ts";
import { paths } from "../../paths.ts";
import { onAbortSignal } from "./signal.ts";

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

const BASH_PARAMS = type({
  command: type("string").describe("要执行的 shell 命令"),
  "timeout?": type("number").describe("超时秒数，默认 60，最大 300"),
});

// 子进程只拿白名单环境变量与 PI_*，避免把 API key 递给模型写的脚本。
function sandboxEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_ALLOW[key] === true || key.startsWith("PI_")) out[key] = value;
  }
  out.HOME = cwd;
  out.CFPA_ROOT = paths.root;
  return out;
}

function shellQuote(command: string): string {
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

// 容器里以 nobody 跑，防止写穿到仓库工作树与会话目录。
function dropPrivileges(command: string): string {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return command;
  return `exec setpriv --reuid=65534 --regid=65534 --clear-groups bash -lc ${shellQuote(command)}`;
}

export function bashTool(ctx: ToolContext): CustomTool<typeof BASH_PARAMS> {
  return {
    name: "bash",
    label: "执行 shell",
    description: "在会话 workspace 执行 bash；evalScope=off 时调用会被拒绝。",
    parameters: BASH_PARAMS,
    execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
      const cwd = localDir(ctx.sessionId);
      const timeoutMs = Math.min(300_000, Math.max(1_000, (params.timeout ?? 60) * 1000));
      const proc = Bun.spawn(["bash", "-lc", dropPrivileges(params.command)], {
        cwd,
        env: sandboxEnv(process.env, cwd),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      const stopListening = onAbortSignal(signal, () => proc.kill());
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      stopListening();
      const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: output || `(exit ${exitCode})` }],
        details: { exitCode, stdout, stderr },
      };
    },
  };
}
