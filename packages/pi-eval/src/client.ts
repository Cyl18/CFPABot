import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { OutputSink } from "./output.ts";
import { parseFrame, type RunnerFrame } from "./protocol.ts";

export interface SandboxFile {
  path: string;
  content: string;
}

export interface SandboxOptions {
  image: string;
}

export interface SandboxRequest {
  language: "py" | "js" | "bash";
  code: string;
  timeoutMs: number;
  stdin?: string;
  files?: SandboxFile[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  cancelled: boolean;
  outputLimited: boolean;
  fullStdout?: string;
  fullStderr?: string;
  outputs?: SandboxFile[];
}

type ResultFrame = Extract<RunnerFrame, { type: "result" }>;

async function readOutputs(workdir: string): Promise<SandboxFile[]> {
  const files: SandboxFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else if (entry.isFile()) files.push({ path: relative, content: await readFile(join(dir, entry.name), "utf8") });
    }
  };
  await walk(join(workdir, "out"), "");
  return files;
}

const MAX_CONTAINERS = 2;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
let runningContainers = 0;
const containerWaiters: (() => void)[] = [];

// shortcut: fixed global cap; make it configurable when eval grows beyond review sessions.
async function acquireContainer(): Promise<() => void> {
  if (runningContainers >= MAX_CONTAINERS) {
    await new Promise<void>((resolve) => containerWaiters.push(resolve));
  }
  runningContainers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runningContainers -= 1;
    containerWaiters.shift()?.();
  };
}

function spawnDocker(args: string[]) {
  try {
    return Bun.spawn(["docker", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(
      `无法启动 docker：${error instanceof Error ? error.message : String(error)}。请确认 Docker 可用，或关闭 evalScope。`,
    );
  }
}

export async function runSandbox(
  request: SandboxRequest,
  options: SandboxOptions,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const release = await acquireContainer();
  try {
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
      const result = await executeSandbox(request, options, workdir, signal);
      result.outputs = await readOutputs(workdir);
      return result;
    } finally {
      await rm(workdir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  } finally {
    release();
  }
}

async function executeSandbox(
  request: SandboxRequest,
  options: SandboxOptions,
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
    options.image,
  ];

  const proc = spawnDocker(args);
  if (proc.stdin === undefined) throw new Error("沙箱控制通道不可用。");

  const stdoutSink = new OutputSink();
  const stderrSink = new OutputSink();
  const fullStdout: string[] = [];
  const fullStderr: string[] = [];
  const state: { result: ResultFrame | null } = { result: null };
  let cancelled = false;
  let outputLimited = false;
  const control = { cancel: (): void => {} };
  const started = Date.now();

  const enforceOutputLimit = (): void => {
    if (outputLimited) return;
    if (stdoutSink.totalBytes + stderrSink.totalBytes <= MAX_OUTPUT_BYTES) return;
    outputLimited = true;
    stderrSink.push("\n[eval 输出超过 16 MiB，已中止]\n");
    control.cancel();
  };

  const readFrames = async (): Promise<void> => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line: string): void => {
      const frame = parseFrame(line);
      if (frame === null) return;
      if (frame.type === "stdout") {
        stdoutSink.push(frame.data);
        fullStdout.push(frame.data);
      } else if (frame.type === "stderr") {
        stderrSink.push(frame.data);
        fullStderr.push(frame.data);
      } else if (frame.type === "result") state.result = frame;
      else {
        const text = `${frame.message}\n`;
        stderrSink.push(text);
        fullStderr.push(text);
      }
      enforceOutputLimit();
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
      const text = decoder.decode(value, { stream: true });
      stderrSink.push(text);
      fullStderr.push(text);
      enforceOutputLimit();
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
  control.cancel = cancel;

  const timer = setTimeout(cancel, request.timeoutMs);
  if (signal?.aborted === true) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });

  writeLine(
    `${JSON.stringify({
      type: "run",
      language: request.language,
      code: request.code,
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    })}\n`,
  );
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
        outputLimited,
        fullStdout: fullStdout.join(""),
        fullStderr: fullStderr.join(""),
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
    outputLimited,
    fullStdout: fullStdout.join(""),
    fullStderr: fullStderr.join(""),
  };
}
