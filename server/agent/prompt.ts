import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths.ts";

const AGENT_DIR = join(paths.config, "agent");

async function readPrompt(file: string): Promise<string> {
  try {
    return (await readFile(join(AGENT_DIR, file), "utf8")).trim();
  } catch {
    throw new Error(`缺少提示词文件 config/agent/${file}`);
  }
}

export async function buildSystemPrompt(review: boolean): Promise<string> {
  const system = await readPrompt("system.md");
  if (!review) return system;
  return `${system}\n\n${await readPrompt("review.md")}`;
}
