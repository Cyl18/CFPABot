import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { resourceTree } from "./resources/tree.ts";
import { WRITE_TARGETS } from "./resources/write-targets.ts";

const AGENT_DIR = join(paths.config, "agent");
const TREE_PLACEHOLDER = "{{RESOURCE_TREE}}";
const WRITE_PLACEHOLDER = "{{WRITE_TARGETS}}";

async function readPrompt(file: string): Promise<string> {
  try {
    return (await readFile(join(AGENT_DIR, file), "utf8")).trim();
  } catch {
    throw new Error(`缺少提示词文件 config/agent/${file}`);
  }
}

export async function buildSystemPrompt(review: boolean): Promise<string> {
  const writeTable = [
    "```",
    ...WRITE_TARGETS.map((target) => `${target.methods.join("/")}\t${target.uri}\t# ${target.summary}`),
    "```",
  ].join("\n");
  const system = (await readPrompt("system.md"))
    .replace(TREE_PLACEHOLDER, resourceTree())
    .replace(WRITE_PLACEHOLDER, writeTable);
  if (!review) return system;
  return `${system}\n\n${await readPrompt("review.md")}`;
}
