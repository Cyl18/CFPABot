import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { env } from "../../env.ts";
import { OutputSink } from "./output.ts";
import { parseFrame, type RunnerFrame } from "./protocol.ts";

export interface SandboxFile {
  path: string;
  content: string;
}

export interface SandboxRequest {
  language: "py" | "js" | "bash";
  code: string;
  timeoutMs: number;
  files?: SandboxFile[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  cancelled: boolean;
}

type ResultFrame = Extract<RunnerFrame, { type: "result" }>;

function spawnDocker(args: string[]) {
  try {
    return Bun.spawn(["docker", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(
      `无法启动 docker：${error instanceof Error ? error.message : String(error)}。请确认 Docker 可用，或关闭 evalScope。`,
    );
  }
}

export async function runSandbox(request: SandboxRequest, signal?: AbortSignal): Promise<SandboxResult> {
  const workdir = await mkdtemp(join(tmpdir(), "cfpa-eval-"));
  try {
    await mkdir(join(workdir, "in"), { recursive: true });
    await mkdir(join(workdir, "out"), { recursive: true });
    for (const file of request.files ?? []) {
      if (file.path.length === 0 || isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) {
        throw new Error(`eval 输入路径无效：${file.path}`);
      }
      const target = join(workdir, "in", file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    await chmod(workdir, 0o777).catch(() => undefined);
    await chmod(join(workdir, "in"), 0o777).catch(() => undefined);
    await chmod(join(workdir, "out"), 0o777).catch(() => undefined);
    return await executeSandbox(request, workdir, signal);
  } finally {
    await rm(workdir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

async function executeSandbox(
  request: SandboxRequest,
  workdir: string,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const name = `cfpa-eval-${crypto.randomUUID().slice(0, 8)}`;
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=64m,mode=1777",
    "-v",
    `${workdir}:/workspace`,
    "-v",
    `${join(workdir, "in")}:/workspace/in:ro`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--user",
    "65534:65534",
    "--env",
    "PYTHONUNBUFFERED=1",
    env.EVAL_DOCKER_IMAGE,
  ];

  const proc = spawnDocker(args);
  if (proc.stdin === undefined) throw new Error("沙箱控制通道不可用。");

  const stdoutSink = new OutputSink();
  const stderrSink = new OutputSink();
  const state: { result: ResultFrame | null } = { result: null };
  let cancelled = false;
  const started = Date.now();

  const readFrames = async (): Promise<void> => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line: string): void => {
      const frame = parseFrame(line);
      if (frame === null) return;
      if (frame.type === "stdout") stdoutSink.push(frame.data);
      else if (frame.type === "stderr") stderrSink.push(frame.data);
      else if (frame.type === "result") state.result = frame;
      else stderrSink.push(`${frame.message}\n`);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    consume(buffer);
  };

  const readStderr = async (): Promise<void> => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrSink.push(decoder.decode(value, { stream: true }));
    }
  };

  const writeLine = (line: string): void => {
    try {
      proc.stdin?.write(line);
      void proc.stdin?.flush();
    } catch {
      // The container may already be gone; the exit path reports it.
    }
  };

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    writeLine(`${JSON.stringify({ type: "cancel" })}\n`);
    killTimer = setTimeout(() => {
      try {
        void Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" }).exited;
      } catch {
        // Best effort; proc.kill below still releases the CLI.
      }
      proc.kill();
    }, 1_500);
  };

  const timer = setTimeout(cancel, request.timeoutMs);
  if (signal?.aborted === true) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });

  writeLine(`${JSON.stringify({ type: "run", language: request.language, code: request.code })}\n`);
  const frames = readFrames();
  const errors = readStderr();
  const exitCode = await proc.exited;
  await Promise.all([frames, errors]);
  clearTimeout(timer);
  clearTimeout(killTimer);
  signal?.removeEventListener("abort", cancel);

  const out = stdoutSink.dump();
  const err = stderrSink.dump();
  const result = state.result;
  const durationMs = result?.durationMs ?? Date.now() - started;
  if (result === null) {
    if (cancelled) {
      return {
        stdout: out.text,
        stderr: err.text,
        exitCode: 124,
        durationMs,
        truncated: out.truncated || err.truncated,
        cancelled: true,
      };
    }
    const detail = err.text.trim();
    throw new Error(`沙箱启动失败：${detail.length > 0 ? detail : `退出码 ${exitCode}`}`);
  }
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: result.exitCode,
    durationMs,
    truncated: out.truncated || err.truncated,
    cancelled: result.cancelled === true || cancelled,
  };
}
