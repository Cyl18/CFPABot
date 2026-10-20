import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolContext } from "../context.ts";
import { readGh } from "./gh-read.ts";
import { readHelp } from "./help.ts";
import { readLocal } from "./local-read.ts";
import { editLocal, writeLocal } from "./local-write.ts";
import { editPr, unsupportedWrite, writePr } from "./pr-write.ts";
import { readPr } from "./pr-read.ts";
import { readRepo } from "./repo-files.ts";
import { readSkill } from "./skill-read.ts";
import { parseUri } from "./uri.ts";
import { findWriteTarget } from "./write-targets.ts";

export async function readResource(
  uri: string,
  ctx: ToolContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const parsed = parseUri(uri);
  switch (parsed.scheme) {
    case "help":
      return readHelp(parsed);
    case "repo":
      return readRepo(parsed);
    case "gh":
      return readGh(parsed);
    case "pr":
      return readPr(parsed);
    case "local":
      return readLocal(parsed, ctx);
    case "skill":
      return readSkill(parsed);
  }
}

export async function writeResource(
  uri: string,
  content: string | undefined,
  ctx: ToolContext,
  toolCallId: string,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const parsed = parseUri(uri);
  const target = findWriteTarget("write", parsed);
  if (target === undefined) throw unsupportedWrite("write");
  if (target.scope === "local") {
    if (parsed.scheme !== "local") throw unsupportedWrite("write");
    return writeLocal(parsed, content, ctx);
  }
  if (parsed.scheme !== "pr") throw unsupportedWrite("write");
  return writePr(parsed, target, content, ctx, toolCallId);
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
  const target = findWriteTarget("edit", parsed);
  if (target === undefined) throw unsupportedWrite("edit");
  if (target.scope === "local") {
    if (parsed.scheme !== "local") throw unsupportedWrite("edit");
    return editLocal(parsed, oldString, newString, replaceAll, ctx);
  }
  if (parsed.scheme !== "pr") throw unsupportedWrite("edit");
  return editPr(parsed, target, oldString, newString, replaceAll, ctx, toolCallId);
}
