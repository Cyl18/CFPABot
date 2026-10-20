import { runSandbox, type SandboxFile, type SandboxResult } from "./client.ts";

export type EvalLanguage = "py" | "js" | "bash";

export interface EvalInput {
  language: EvalLanguage;
  code: string;
  timeoutMs?: number;
  stdin?: string;
  inputs?: string[];
  outputs?: string[];
}

export interface EvalFiles {
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
}

export interface EvalOptions {
  image: string;
}

export interface EvalResult extends Omit<SandboxResult, "fullStdout" | "fullStderr" | "outputs"> {
  log: string;
  outputs: Array<{ name: string; size: number; path: string }>;
}

const LOCAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CODE_BYTES = 64 * 1024;

export async function runEval(
  input: EvalInput,
  files: EvalFiles,
  options: EvalOptions,
  signal?: AbortSignal,
): Promise<EvalResult> {
  if (input.code.trim().length === 0) throw new Error("code 不能为空。");
  if (Buffer.byteLength(input.code, "utf8") > MAX_CODE_BYTES) throw new Error("code 超过 64 KiB 上限。");
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const sandboxFiles: SandboxFile[] = [];
  for (const uri of input.inputs ?? []) {
    if (!uri.startsWith("local://")) throw new Error("eval inputs 目前只支持 local://。");
    const name = uri.slice("local://".length).trim();
    if (!LOCAL_NAME_PATTERN.test(name)) throw new Error(`本地文件名无效：${name}`);
    const content = await files.read(name);
    if (content === null) throw new Error(`本地文件不存在：${uri}`);
    sandboxFiles.push({ path: name, content });
  }
  let stdin = input.stdin;
  if (stdin?.startsWith("local://")) {
    const name = stdin.slice("local://".length).trim();
    if (!LOCAL_NAME_PATTERN.test(name)) throw new Error(`本地文件名无效：${name}`);
    const content = await files.read(name);
    if (content === null) throw new Error(`本地文件不存在：local://${name}`);
    stdin = content;
  }
  for (const name of input.outputs ?? []) {
    if (!LOCAL_NAME_PATTERN.test(name)) throw new Error(`输出文件名无效：${name}`);
  }
  const { fullStdout, fullStderr, outputs: sandboxOutputs, ...result } = await runSandbox(
    {
      language: input.language,
      code: input.code,
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
      ...(sandboxFiles.length > 0 ? { files: sandboxFiles } : {}),
    },
    options,
    signal,
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logName = `eval-${stamp}.log`;
  await files.write(logName, `--- stdout ---\n${fullStdout ?? ""}\n--- stderr ---\n${fullStderr ?? ""}`);
  const saved: EvalResult["outputs"] = [];
  for (const name of input.outputs ?? []) {
    const file = sandboxOutputs?.find((entry) => entry.path === name || entry.path.endsWith(`/${name}`));
    if (!file) continue;
    await files.write(name, file.content);
    saved.push({ name, size: Buffer.byteLength(file.content, "utf8"), path: `local://${name}` });
  }
  return { ...result, log: `local://${logName}`, outputs: saved };
}
