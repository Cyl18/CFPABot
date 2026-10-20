import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getActiveSkills } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { jsonResult } from "../result.ts";
import { linesResult } from "./format.ts";
import type { SkillUri } from "./uri.ts";

export async function readSkill(uri: SkillUri): Promise<AgentToolResult<Record<string, unknown>>> {
  const segments = uri.path.split("/").filter(Boolean);
  const name = segments[0];
  if (name === undefined) throw new Error("skill:// 需要技能名：skill://<name>");
  const skill = getActiveSkills().find((entry) => entry.name === name);
  if (skill === undefined) throw new Error(`技能不存在：skill://${name}`);
  const target = segments.length === 1 ? skill.filePath : resolve(skill.baseDir, ...segments.slice(1));
  if (segments.length > 1) {
    const rel = relative(skill.baseDir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`技能路径越界：skill://${uri.path}`);
  }
  const content = await readFile(target, "utf8");
  return jsonResult(linesResult(`skill://${uri.path}`, "skill", content, uri.selector));
}
