import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { resourceTree } from "../harness/catalog.ts";
import { WRITE_TARGETS } from "../harness/write-targets.ts";
import type { WorkflowDefinition } from "./workflows/types.ts";

const AGENT_DIR = join(paths.config, "agent");
const TREE_PLACEHOLDER = "{{RESOURCE_TREE}}";
const WRITE_PLACEHOLDER = "{{WRITE_TARGETS}}";
const WORKSPACE_PLACEHOLDER = "{{WORKSPACE_DIR}}";
const ROOT_PLACEHOLDER = "{{ROOT_DIR}}";
const PR_PLACEHOLDER = "{{PR_BOUND}}";

async function readPrompt(file: string): Promise<string> {
  try {
    return (await readFile(join(AGENT_DIR, file), "utf8")).trim();
  } catch {
    throw new Error(`缺少提示词文件 config/agent/${file}`);
  }
}

export async function buildSystemPrompt(
  workflow: WorkflowDefinition,
  workspaceDir: string,
  repoRoot: string,
  prNumber?: number,
): Promise<string> {
  const writeTable = [
    "```",
    ...WRITE_TARGETS.map((target) => `${target.uri}\t# ${target.summary}`),
    "```",
  ].join("\n");
  const prBound =
    prNumber === undefined
      ? "本会话未绑定 PR。用户给出编号后，从 `read pr://<n>?review=1&limit=120` 开始。"
      : `本会话绑定 PR #${prNumber}。审查从 \`read pr://${prNumber}?review=1&limit=120\` 开始，返回的 rows.next 继续读。`;
  const system = (await readPrompt("system.md"))
    .replace(TREE_PLACEHOLDER, resourceTree())
    .replace(WRITE_PLACEHOLDER, writeTable)
    .replace(WORKSPACE_PLACEHOLDER, workspaceDir)
    .replaceAll(ROOT_PLACEHOLDER, repoRoot)
    .replace(PR_PLACEHOLDER, prBound);
  const fragments = await Promise.all(workflow.promptFiles.map(readPrompt));
  return [system, ...fragments].filter(Boolean).join("\n\n");
}
