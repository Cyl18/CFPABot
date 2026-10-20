import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../context.ts";
import { isLocalPath } from "../local-store.ts";
import { jsonResult } from "../result.ts";
import { linesResult } from "./format.ts";
import type { LocalUri } from "./uri.ts";

export async function readLocal(
  uri: LocalUri,
  ctx: ToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const name = uri.path.trim();
  if (name.length === 0) {
    const files = await ctx.listLocal();
    return jsonResult({ files: [...files].sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (!isLocalPath(name)) {
    throw new Error("本地路径无效：只能是相对路径，不能含 .. 或绝对路径。");
  }
  const entry = await ctx.local(name);
  if (entry === null) throw new Error(`本地文件不存在：local://${name}`);
  return jsonResult(linesResult(name, "local", entry.content, uri.selector));
}
