import { type } from "@oh-my-pi/omptype";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CustomTool, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolContext } from "../context.ts";
import { loadConfig, resolveModel } from "../llm.ts";
import { parseRoleSelector } from "../llm-providers.ts";
import { paths } from "../../paths.ts";
import { agentMcpManager } from "../mcp.ts";
import { openAuthStorage, openModelRuntime } from "../pi.ts";

// 子代理只读：agent md 声明的工具先过这张表，再交给 SDK 装配。
const CHILD_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  find: true,
  glob: true,
  bash: true,
};

const AGENTS_DIR = join(paths.root, ".omp", "agents");

const AGENT_NAME = /^[A-Za-z0-9_-]+$/;

const OPERATING_RULES = [
  "你是子代理：只读、一次交卷。",
  "- 任务给的路径照着用；workspace 里的文件用 bash 读（cwd 就是它），`local://` 在这边不通；MQM 分类表读 skills/post/SKILL.md。",
  "- 不要派发子代理，不要跑验证、测试或发布。",
  "- 只回结论，不回工具过程。",
].join("\n");

const DELEGATE_PARAMS = type({
  "agent?": type("string").describe("子代理定义名，例如 review（对应 .omp/agents/review.md）"),
  "model?": type("string").describe("模型名，取自系统提示末尾的可用模型，例如 @匿名模型a"),
  task: type("string").describe("交给子代理的任务"),
});

interface AgentSpec {
  agent: AgentDefinition;
  output: unknown;
}

async function agentNames(): Promise<string> {
  const entries = await readdir(AGENTS_DIR).catch(() => [] as string[]);
  return (
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.slice(0, -3))
      .join("、") || "（无）"
  );
}

async function loadAgent(name: string): Promise<AgentSpec> {
  if (name === "") throw new Error(`缺少 agent：可用子代理 ${await agentNames()}`);
  if (!AGENT_NAME.test(name)) throw new Error(`子代理名只能是字母、数字、下划线和连字符：${name}`);
  const file = join(AGENTS_DIR, `${name}.md`);
  const content = await readFile(file, "utf8").catch(() => null);
  if (content === null) throw new Error(`没有子代理定义 .omp/agents/${name}.md；可用子代理 ${await agentNames()}`);
  const agent = parseAgent(file, content, "project", "fatal");
  if (agent.output === undefined) throw new Error(`.omp/agents/${name}.md 缺少 output schema`);
  return {
    agent: {
      ...agent,
      systemPrompt: `${agent.systemPrompt.trim()}\n\n${OPERATING_RULES}`,
      tools: (agent.tools ?? []).filter((tool) => CHILD_TOOLS[tool] === true),
    },
    output: agent.output,
  };
}

let sequence = 0;

export function delegateTool(ctx: ToolContext, extensions: ExtensionFactory[]): CustomTool<typeof DELEGATE_PARAMS> {
  return {
    name: "delegate",
    label: "派发子代理",
    description:
      "按 agent 定义与模型启动只读子代理（例如 agent=review，model=@匿名模型a），返回结构化 findings JSON。子代理的 bash cwd 是本会话 workspace，read/grep 相对仓库根；local:// 不通。",
    parameters: DELEGATE_PARAMS,
    execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
      const agentName = (params.agent ?? "").trim();
      const roleName = (params.model ?? "").trim().replace(/^@/, "");
      const config = await loadConfig();
      const available = Object.keys(config.roles)
        .filter((role) => role !== "default")
        .map((role) => `@${role}`)
        .join("、");
      if (roleName === "") throw new Error(`缺少 model：可用模型 ${available || "（未配置）"}`);
      const selector = config.roles[roleName];
      if (selector === undefined) throw new Error(`未知模型 @${roleName}；可用：${available || "（未配置）"}`);
      const spec = await loadAgent(agentName);
      const { endpoint, thinking } = parseRoleSelector(selector);
      // 先确认端点存在，避免 SDK 的模型解析静默回退到别的模型。
      await resolveModel(endpoint, thinking);
      const authStorage = await openAuthStorage(config.endpoints);
      const { settings, registry } = await openModelRuntime(authStorage, config.endpoints, config.roles);
      const mcpManager = ctx.mcpManager?.() ?? (await agentMcpManager());
      try {
        const result = await runSubprocess({
          cwd: paths.root,
          agent: spec.agent,
          task: params.task,
          id: `${agentName}-${Date.now().toString(36)}-${++sequence}`,
          index: 0,
          modelOverride: [`@${roleName}`],
          structured: true,
          outputSchema: spec.output,
          authStorage,
          settings,
          modelRegistry: registry,
          enableLsp: false,
          enableIrc: false,
          keepAlive: false,
          preloadedCustomToolPaths: [],
          preloadedPreparedExtensions: extensions.map((factory, index) => ({
            path: `<cfpa-extension:${index}>`,
            resolvedPath: `<cfpa-extension:${index}>`,
            factory,
            error: null,
          })),
          ...(mcpManager === undefined ? { enableMCP: false } : { mcpManager }),
          signal,
        });
        if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
          throw new Error(result.error ?? (result.stderr.trim() || "子代理失败"));
        }
        const data = result.structuredOutput?.data;
        return {
          content: [
            {
              type: "text",
              text: data === undefined ? result.output.trim() || "(子代理没有返回结果)" : JSON.stringify(data),
            },
          ],
          details: { agent: agentName, model: roleName, endpoint, thinking },
        };
      } finally {
        authStorage.close();
      }
    },
  };
}
