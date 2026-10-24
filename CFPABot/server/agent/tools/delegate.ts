import { type } from "@oh-my-pi/omptype";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type CustomTool,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { ToolContext } from "../context.ts";
import { loadConfig, resolveModel } from "../llm.ts";
import { parseRoleSelector } from "../llm-providers.ts";
import { paths } from "../../paths.ts";
import { agentMcpManager } from "../mcp.ts";
import { openAuthStorage, openModelRuntime } from "../pi.ts";
import { onAbortSignal } from "./signal.ts";

const CHILD_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  find: true,
  glob: true,
  bash: true,
  yield: true,
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
  systemPrompt: string;
  tools: string[];
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
    systemPrompt: `${agent.systemPrompt.trim()}\n\n${OPERATING_RULES}`,
    tools: (agent.tools ?? []).filter((tool) => CHILD_TOOLS[tool] === true),
    output: agent.output,
  };
}

/** yield 在工具内校验过 schema，父代理只取最后一次交卷的 data。 */
function yieldedData(messages: readonly unknown[]): unknown {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = block as { type?: string; name?: string; arguments?: unknown };
      if (call?.type !== "toolCall" || call.name !== "yield") continue;
      const args = call.arguments as { data?: unknown } | undefined;
      if (args !== undefined && "data" in args) return args.data;
    }
  }
  return undefined;
}

export function delegateTool(
  ctx: ToolContext,
  childTools: (ctx: ToolContext) => CustomTool[],
  extensions: ExtensionFactory[],
): CustomTool<typeof DELEGATE_PARAMS> {
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
      const { endpoint: endpointId, thinking } = parseRoleSelector(selector);
      const { model } = await resolveModel(endpointId, thinking);
      const authStorage = await openAuthStorage(config.endpoints);
      const runtime = await openModelRuntime(authStorage, config.endpoints, config.roles);
      const inherited = ctx.mcpManager?.() ?? (await agentMcpManager());
      const created = await createAgentSession({
        cwd: paths.root,
        agentDir: paths.piAgent,
        model,
        authStorage,
        modelRegistry: runtime.registry,
        settings: runtime.settings,
        sessionManager: SessionManager.inMemory(paths.root),
        customTools: childTools(ctx).filter((tool) => CHILD_TOOLS[tool.name] === true),
        extensions,
        disableExtensionDiscovery: true,
        systemPrompt: spec.systemPrompt,
        outputSchema: spec.output,
        requireYieldTool: true,
        ...(inherited === undefined ? { enableMCP: false } : { mcpManager: inherited }),
      });
      const session = created.session;
      // 共享 manager 不参与本会话发现，刷新只负责把工具注册并激活。
      if (inherited) await session.refreshMCPTools(inherited.getTools());
      const allowed = new Set(["yield", ...spec.tools]);
      const stopListening = onAbortSignal(signal, () => void session.abort());
      try {
        await session.setActiveToolsByName(
          session.getActiveToolNames().filter((name) => allowed.has(name) || name.startsWith("mcp__")),
        );
        await session.prompt(params.task);
        const messages = session.agent.state.messages;
        const last = messages.at(-1);
        if (last?.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
        const data = yieldedData(messages);
        const text =
          last?.role === "assistant"
            ? last.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")
                .trim()
            : "";
        return {
          content: [
            {
              type: "text",
              text: data === undefined ? text || "(子代理没有返回结果)" : JSON.stringify(data),
            },
          ],
          details: { agent: agentName, model: roleName, endpoint: endpointId, thinking },
        };
      } finally {
        stopListening();
        await session.dispose().catch(() => {});
        authStorage.close();
      }
    },
  };
}
