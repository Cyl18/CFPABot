import { type } from "@oh-my-pi/omptype";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  loadSkillsFromDir,
  type CustomTool,
  type ExtensionFactory,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ThinkingLevel } from "@cfpa/contracts/api";
import type { ToolContext } from "../context.ts";
import { loadConfig, resolveModel } from "../llm.ts";
import { parseRoleSelector } from "../llm-providers.ts";
import { paths } from "../../paths.ts";
import { localDir } from "../local-store.ts";
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
const SKILLS_DIR = join(paths.root, "skills");

const AGENT_NAME = /^[A-Za-z0-9_-]+$/;

const OPERATING_RULES = [
  "你是子代理：只读、一次交卷。",
  "- 数据面与主代理相同：`read pr://<n>/rows?...`、`pr://<n>/terms?changed=1`、`pr://<n>/special-files?include=text` 都能用；`pr://<n>` 是简报。",
  "- 任务给了 resources 就直接读，别重读全量。子代理 cwd 是仓库根；主代理 workspace 的绝对路径见任务上下文，也可用 `read local://...`。",
  "- MQM 分类表读 `skill://post`；术语依据用 `pr://<n>/terms`，不要读缓存文件。",
  "- 不要派发子代理，不要跑验证、测试或发布。",
  "- 只回结论，不回工具过程。",
].join("\n");

const DELEGATE_PARAMS = type({
  "agent?": type("string").describe("子代理定义名，例如 review（对应 .omp/agents/review.md）"),
  "model?": type("string").describe("可选模型别名，例如 @匿名模型a；省略时用默认模型"),
  task: type("string").describe("交给子代理的任务：分片范围、判什么、返回什么"),
  "resources?": type("string[]").describe("预取的只读资源 URI；内容会随任务一起交给子代理"),
  "context?": type("string").describe("额外的共享上下文，例如本轮裁定或风格约定"),
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

let skillsPromise: Promise<Skill[]> | undefined;

function childSkills(): Promise<Skill[]> {
  skillsPromise ??= loadSkillsFromDir({ dir: SKILLS_DIR, source: "delegate" }).then((loaded) => loaded.skills);
  return skillsPromise;
}

/** 父代理已经拿到分片时，直接把内容带进子代理上下文，省掉一次重复取数。 */
async function prefetch(resources: readonly string[], sessionId: string): Promise<string> {
  if (resources.length === 0) return "";
  const router = InternalUrlRouter.instance();
  const localProtocolOptions = {
    getArtifactsDir: () => localDir(sessionId),
    getSessionId: () => sessionId,
  };
  const blocks = await Promise.all(
    resources.map(async (uri) => {
      try {
        const resource = await router.resolve(uri, { cwd: paths.root, localProtocolOptions });
        return `## 预取资源 ${uri}\n\n${resource.content}`;
      } catch (err) {
        return `## 预取资源 ${uri} 失败\n\n${err instanceof Error ? err.message : String(err)}`;
      }
    }),
  );
  return ["# 已预取资源", ...blocks].join("\n\n");
}

let sequence = 0;

export function delegateTool(ctx: ToolContext, extensions: ExtensionFactory[]): CustomTool<typeof DELEGATE_PARAMS> {
  return {
    name: "delegate",
    label: "派发子代理",
    description:
      "按 agent 定义启动只读子代理，返回结构化 findings JSON。model 可省；resources 会把 pr:// 等只读资源预取进子代理上下文。子代理与主代理共用 pr:// 数据面与 glossary。",
    parameters: DELEGATE_PARAMS,
    execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
      const agentName = (params.agent ?? "").trim();
      const roleName = (params.model ?? "").trim().replace(/^@/, "");
      const config = await loadConfig();
      const available = Object.keys(config.roles)
        .filter((role) => role !== "default")
        .map((role) => `@${role}`)
        .join("、");
      const spec = await loadAgent(agentName);
      let modelOverride: string[] | undefined;
      let endpoint: string | undefined;
      let thinking: ThinkingLevel | undefined;
      if (roleName !== "") {
        const selector = config.roles[roleName];
        if (selector === undefined) throw new Error(`未知模型 @${roleName}；可用：${available || "（未配置）"}`);
        const parsed = parseRoleSelector(selector);
        endpoint = parsed.endpoint;
        thinking = parsed.thinking;
        // 先确认端点存在，避免 SDK 的模型解析静默回退到别的模型。
        await resolveModel(endpoint, thinking);
        modelOverride = [`@${roleName}`];
      }
      const authStorage = await openAuthStorage(config.endpoints);
      const { settings, registry } = await openModelRuntime(authStorage, config.endpoints, config.roles);
      const mcpManager = ctx.mcpManager?.() ?? (await agentMcpManager());
      try {
        const shared = [
          params.context,
          `主代理 workspace：${localDir(ctx.sessionId)}\n仓库根：${paths.root}`,
          await prefetch(params.resources ?? [], ctx.sessionId),
        ]
          .filter(Boolean)
          .join("\n\n");
        const result = await runSubprocess({
          cwd: paths.root,
          additionalDirectories: [localDir(ctx.sessionId)],
          localProtocolOptions: {
            getArtifactsDir: () => localDir(ctx.sessionId),
            getSessionId: () => ctx.sessionId,
          },
          agent: spec.agent,
          task: params.task,
          ...(shared === "" ? {} : { context: shared }),
          id: `${agentName}-${Date.now().toString(36)}-${++sequence}`,
          index: 0,
          ...(modelOverride === undefined ? {} : { modelOverride }),
          structured: true,
          outputSchema: spec.output,
          authStorage,
          settings,
          modelRegistry: registry,
          enableLsp: false,
          enableIrc: false,
          keepAlive: false,
          skills: await childSkills(),
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
          details: {
            agent: agentName,
            ...(roleName === "" ? {} : { model: roleName }),
            ...(endpoint === undefined ? {} : { endpoint }),
            ...(thinking === undefined ? {} : { thinking }),
            resources: params.resources ?? [],
          },
        };
      } finally {
        authStorage.close();
      }
    },
  };
}
