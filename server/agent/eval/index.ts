import type { ToolContext } from "../context.ts";
import { LOCAL_NAME_PATTERN } from "../sessions.ts";
import { runSandbox, type SandboxFile, type SandboxResult } from "./client.ts";

export type EvalLanguage = "py" | "js" | "bash";

export interface EvalInput {
  language: EvalLanguage;
  code: string;
  timeoutMs?: number;
  inputs?: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CODE_BYTES = 64 * 1024;

export async function runEval(input: EvalInput, ctx: ToolContext, signal?: AbortSignal): Promise<SandboxResult> {
  if (ctx.evalScope !== "run") {
    throw new Error("执行权限未开启：本会话 evalScope=off。管理员可在会话上开启 run。");
  }
  if (input.code.trim().length === 0) throw new Error("code 不能为空。");
  if (Buffer.byteLength(input.code, "utf8") > MAX_CODE_BYTES) throw new Error("code 超过 64 KiB 上限。");
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const files: SandboxFile[] = [];
  for (const uri of input.inputs ?? []) {
    if (!uri.startsWith("local://")) throw new Error("eval inputs 目前只支持 local://。");
    const name = uri.slice("local://".length).trim();
    if (!LOCAL_NAME_PATTERN.test(name)) throw new Error(`本地文件名无效：${name}`);
    const entry = await ctx.local(name);
    if (entry === null) throw new Error(`本地文件不存在：${uri}`);
    files.push({ path: name, content: entry.content });
  }
  return runSandbox(
    { language: input.language, code: input.code, timeoutMs, ...(files.length > 0 ? { files } : {}) },
    signal,
  );
}
