import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../context.ts";
import { LOCAL_NAME_PATTERN } from "../sessions.ts";
import { jsonResult } from "../tools/shared.ts";
import type { LocalUri } from "./uri.ts";
import { replaceOnce } from "./replace.ts";

export async function writeLocal(
  uri: LocalUri,
  content: string | undefined,
  ctx: ToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const name = uri.path.trim();
  if (!LOCAL_NAME_PATTERN.test(name)) {
    throw new Error("本地文件名无效：只能是 1-64 位字母、数字、点、下划线或连字符。");
  }
  if (content === undefined) throw new Error("write 需要 content。");
  const saved = await ctx.saveLocal(name, content);
  return jsonResult({
    ok: true,
    path: name,
    bytes: Buffer.byteLength(content, "utf8"),
    updatedAt: saved.updatedAt,
  });
}

export async function editLocal(
  uri: LocalUri,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  ctx: ToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const name = uri.path.trim();
  if (!LOCAL_NAME_PATTERN.test(name)) {
    throw new Error("本地文件名无效：只能是 1-64 位字母、数字、点、下划线或连字符。");
  }
  const file = await ctx.local(name);
  if (file === null) throw new Error(`本地文件不存在：local://${name}`);
  const content = replaceOnce(file.content, oldString, newString, replaceAll);
  const saved = await ctx.saveLocal(name, content);
  return jsonResult({
    ok: true,
    path: name,
    bytes: Buffer.byteLength(content, "utf8"),
    updatedAt: saved.updatedAt,
  });
}
