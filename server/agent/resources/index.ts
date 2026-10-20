import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../context.ts";
import { readHelp } from "./help.ts";
import { readLocal } from "./local-read.ts";
import { editLocal, writeLocal } from "./local-write.ts";
import { editRepo, writeRepo } from "./repo-write.ts";
import { readRepo } from "./repo-read.ts";
import { parseUri } from "./uri.ts";

export async function readResource(
  uri: string,
  ctx: ToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const parsed = parseUri(uri);
  if (parsed.scheme === "help") return readHelp(parsed);
  return parsed.scheme === "repo" ? readRepo(parsed, ctx) : readLocal(parsed, ctx);
}

export async function writeResource(
  uri: string,
  content: string | undefined,
  ctx: ToolContext,
  toolCallId: string,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const parsed = parseUri(uri);
  if (parsed.scheme === "help") throw new Error("help:// 是只读资源。");
  return parsed.scheme === "repo"
    ? writeRepo(parsed, content, ctx, toolCallId)
    : writeLocal(parsed, content, ctx);
}

export async function editResource(
  uri: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  ctx: ToolContext,
  toolCallId: string,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const parsed = parseUri(uri);
  if (parsed.scheme === "help") throw new Error("help:// 是只读资源。");
  return parsed.scheme === "repo"
    ? editRepo(parsed, oldString, newString, replaceAll, ctx, toolCallId)
    : editLocal(parsed, oldString, newString, replaceAll, ctx);
}
