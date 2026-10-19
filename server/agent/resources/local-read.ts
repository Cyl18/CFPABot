import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../context.ts";
import { LOCAL_NAME_PATTERN } from "../sessions.ts";
import { jsonResult } from "../tools/shared.ts";
import { linesResult } from "./format.ts";
import type { LocalUri } from "./uri.ts";

export async function readLocal(
  uri: LocalUri,
  ctx: ToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const name = uri.path.trim();
  if (name.length === 0) {
    const files = await ctx.listLocal();
    files.sort((a, b) => a.name.localeCompare(b.name));
    return jsonResult({ files });
  }
  if (!LOCAL_NAME_PATTERN.test(name)) {
    throw new Error("本地文件名无效：只能是 1-64 位字母、数字、点、下划线或连字符。");
  }
  const entry = await ctx.local(name);
  if (entry === null) throw new Error(`本地文件不存在：local://${name}`);
  return jsonResult(linesResult(name, "local", entry.content, uri.selector));
}
