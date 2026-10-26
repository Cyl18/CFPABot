import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { cfgBashInterceptorEnabled, cfgBashInterceptorPatterns } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { type } from "@oh-my-pi/omptype";
import type { ToolContext } from "../context.ts";
import { localDir, writeLocal } from "../local-store.ts";
import { sessionPaths } from "../session-env.ts";
import { onAbortSignal } from "./signal.ts";

const ENV_ALLOW: Record<string, true> = {
  path: true,
  home: true,
  lang: true,
  lc_all: true,
  pythonioencoding: true,
  tz: true,
  term: true,
  shell: true,
  tmpdir: true,
  temp: true,
  tmp: true,
  localappdata: true,
  appdata: true,
  userprofile: true,
  systemroot: true,
  windir: true,
  comspec: true,
  pathext: true,
};

const BASH_PARAMS = type({
  command: type("string").describe("要执行的 shell 命令"),
  "timeout?": type("number").describe("超时秒数，默认 60，最大 300"),
});

/** Windows 的 System32 bash 是 WSL：它会丢掉 Windows 环境变量，也看不到 D:/ 路径。优先 Git Bash。 */
function bashBinary(): string {
  if (process.platform !== "win32") return "bash";
  const programFiles = process.env.ProgramFiles;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    programFiles === undefined ? undefined : join(programFiles, "Git", "bin", "bash.exe"),
    localAppData === undefined ? undefined : join(localAppData, "Programs", "Git", "bin", "bash.exe"),
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ].filter((path): path is string => path !== undefined);
  return candidates.find((path) => existsSync(path)) ?? "bash";
}

const BASH_BIN = bashBinary();

/** WSL 会丢 env；Git Bash 也统一用 shell 里的显式 export，工具行为不随 shell 改变。 */
function envPrologue(cwd: string, prNumber: number | undefined): string {
  const vars = sessionPaths(cwd, prNumber);
  const env: Record<string, string> = {
    CFPA_ROOT: vars.root,
    CFPA_WORK: vars.work,
    CFPA_REPO: vars.repo,
    CFPA_SESSION: vars.session,
  };
  if (vars.pr !== undefined) env.CFPA_PR = vars.pr;
  const lines = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  if (prNumber === undefined) lines.push("unset CFPA_PR");
  return `${lines.join("\n")}\n`;
}

// 子进程只拿白名单环境变量与 PI_*，避免把 API key 递给模型写的脚本。CFPA_* 由脚本开头的 export 给出。
export function sandboxEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_ALLOW[key.toLowerCase()] === true || key.startsWith("PI_")) out[key] = value;
  }
  // Windows 的 PATH 键大小写不固定；Bun.spawn 查找可执行文件只认 PATH。
  const pathValue = env.PATH ?? env.Path;
  if (pathValue !== undefined) out.PATH = pathValue;
  out.HOME = cwd;
  // Windows 上子进程默认 cp936，输出被工具按 UTF-8 解码就碎成 �；python 与原生工具都靠这三个变量。
  out.LANG ??= "C.UTF-8";
  out.LC_ALL ??= "C.UTF-8";
  out.PYTHONIOENCODING ??= "utf-8";
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

// 程序体走 eval、文件走 write：heredoc 进 shell 后，中文、引号与 $ 会被吃掉，且一次只回答一个问题。
const PYTHON_HEREDOC = /(?:^|[\s;&|(])(?:python[\d.]*|py)\b[^\n]*<</;
const FILE_HEREDOC = /(?:^|[\s;&|(])(?:cat|tee)\b[^\n]*<</;

export function heredocReason(command: string): string | undefined {
  if (PYTHON_HEREDOC.test(command)) {
    return "bash 里不要用 heredoc 跑 python：中文、引号与 `$` 会被 shell 吃掉，而且一次只回答一个问题。改用 `eval`（language=py）在一个细胞里并行读、筛完只打印命中行；脚本超过几行就先 `write` 成 .py 再 `python 文件名.py`。";
  }
  if (FILE_HEREDOC.test(command)) {
    return "bash 里不要用 heredoc 写文件：改用 `write` 写整份内容，或 `edit` 改某一段，路径用 `local://…`。";
  }
  return undefined;
}

export function bashTool(ctx: ToolContext, availableTools: string[]): CustomTool<typeof BASH_PARAMS> {
  return {
    name: "bash",
    label: "执行 shell",
    description:
      "在会话 workspace 执行 bash；cwd 就是 local://。仓库在 $CFPA_REPO，PR 物化目录在 $CFPA_PR，工作区根是 $CFPA_WORK。不要用 heredoc（程序体走 eval，写文件走 write），会被直接拒绝。evalScope=off 时调用会被拒绝。",
    parameters: BASH_PARAMS,
    execute: async (_toolCallId, params, _onUpdate, runtime, signal) => {
      const settings = runtime.settings;
      if (settings !== undefined && cfgBashInterceptorEnabled.get(settings)) {
        // 自定义 bash 没有 name，指向 bash 自身的规则给出的替代方案不存在。
        const rules = cfgBashInterceptorPatterns.get(settings).filter((rule) => rule.tool !== "bash");
        const hit = checkBashInterception(params.command, availableTools, rules);
        if (hit.block) throw new Error(hit.message ?? "这条命令请改用对应的专用工具。");
      }
      const heredoc = heredocReason(params.command);
      if (heredoc !== undefined) throw new Error(heredoc);
      const cwd = localDir(ctx.sessionId);
      const timeoutMs = Math.min(300_000, Math.max(1_000, (params.timeout ?? 60) * 1000));
      const script = `${envPrologue(cwd, ctx.prNumber)}${dropPrivileges(params.command)}`;
      const proc = Bun.spawn([BASH_BIN, "-lc", script], {
        cwd,
        env: sandboxEnv(process.env, cwd),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      const stopListening = onAbortSignal(signal, () => proc.kill());
      const collected = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const grace = Promise.withResolvers<null>();
      const graceTimer = setTimeout(() => grace.resolve(null), timeoutMs + 5_000);
      const result = await Promise.race([collected, grace.promise]);
      clearTimeout(timer);
      clearTimeout(graceTimer);
      stopListening();
      if (result === null) {
        await proc.stdout.cancel().catch(() => undefined);
        await proc.stderr.cancel().catch(() => undefined);
        proc.kill();
        return {
          content: [{ type: "text", text: `bash 超时（>${timeoutMs} ms），后台子进程仍持有输出管道，已放弃等待。` }],
          details: { exitCode: null, timedOut: true },
          isError: true,
        };
      }
      const [stdout, stderr, exitCode] = result;
      const full = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
      const bytes = Buffer.byteLength(full);
      let text = full || `(exit ${exitCode})`;
      let log: string | undefined;
      if (bytes > 50_000) {
        const name = `bash/${Date.now().toString(36)}.log`;
        await writeLocal(ctx.sessionId, name, full).catch(() => undefined);
        log = `local://${name}`;
        text = `${Buffer.from(full).subarray(0, 50_000).toString("utf8")}\n…[输出 ${bytes} B，全文 ${log}]`;
      }
      return {
        content: [{ type: "text", text }],
        details: { exitCode, truncated: bytes > 50_000, ...(log === undefined ? {} : { log }), timedOut },
        ...(exitCode === 0 && !timedOut ? {} : { isError: true }),
      };
    },
  };
}
