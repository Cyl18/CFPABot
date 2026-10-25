import { type } from "@oh-my-pi/omptype";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CustomTool, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SubagentInfo, ThinkingLevel } from "@cfpa/contracts/api";
import type { ToolContext } from "../context.ts";
import { loadConfig, resolveModel } from "../llm.ts";
import { parseRoleSelector } from "../llm-providers.ts";
import { paths } from "../../paths.ts";
import { lineRangeOf, sliceLines } from "../../harness/uri.ts";
import { artifactsDir, localDir } from "../local-store.ts";
import { agentMcpManager } from "../mcp.ts";
import { openAuthStorage, openModelRuntime } from "../pi.ts";
import { subagentDir } from "../subagents.ts";

// 子代理只读：agent md 声明的工具先过这张表，再交给 SDK 装配。
const CHILD_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  find: true,
  glob: true,
};

const AGENTS_DIR = join(paths.root, ".omp", "agents");

const AGENT_NAME = /^[A-Za-z0-9_-]+$/;
const PREFETCH_BYTES = 96_000;
const PREFETCH_TOTAL_BYTES = 192_000;
const MAX_RESOURCES = 12;

const OPERATING_RULES = [
  "你是子代理：只做判断，一次交卷。",
  "- 上下文里已经放好主代理打包的分片：原文、译文、原始行、机械发现、术语命中、旧线程、重复译文。不要自己去找输入。",
  "- 除 glossary 查询外不调工具；要核实术语就用 glossary 工具，一次一个词。",
  "- 不要读 pr://、repo://、gh:// 或任何文件；分片里没有的信息就是没有。",
  "- 拿不准写进 uncertain，不要硬判；没依据不判 major。",
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

/** 父代理已经拿到分片时，直接把内容带进子代理上下文，省掉一次重复取数。 */
async function prefetch(resources: readonly string[], sessionId: string): Promise<string> {
  if (resources.length === 0) return "";
  const router = InternalUrlRouter.instance();
  const localProtocolOptions = {
    getArtifactsDir: () => artifactsDir(sessionId),
    getSessionId: () => sessionId,
  };
  const failures: Error[] = [];
  const blocks = await Promise.all(
    resources.map(async (uri) => {
      const local = /^local:\/\//i.test(uri);
      try {
        const target = router.split(uri);
        const resource = await router.resolve(target.path, { cwd: paths.root, localProtocolOptions });
        const range = target.sel === undefined ? null : lineRangeOf(target.sel);
        const content = range === null ? resource.content : sliceLines(resource.content, range);
        const bytes = Buffer.byteLength(content);
        if (bytes > PREFETCH_BYTES) {
          // 子代理没有读取工具，截断等于让它审半份材料；本地分片必须整份送达。
          if (local) throw new Error(`分片超过预取上限 ${PREFETCH_BYTES} B：${uri}（${bytes} B），重新打包成更小的片`);
          const clipped = Buffer.from(content).subarray(0, PREFETCH_BYTES).toString("utf8");
          return `## 预取资源 ${uri}\n\n${clipped}\n…[预取已截断]`;
        }
        return `## 预取资源 ${uri}\n\n${content}`;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (local) failures.push(error);
        return `## 预取资源 ${uri} 失败\n\n${error.message}`;
      }
    }),
  );
  const first = failures[0];
  if (first !== undefined) throw first;
  const joined = ["# 已预取资源", ...blocks].join("\n\n");
  if (Buffer.byteLength(joined) > PREFETCH_TOTAL_BYTES) {
    throw new Error(`预取总量超过 ${PREFETCH_TOTAL_BYTES} B；减少 resources 或拆片`);
  }
  return joined;
}

let sequence = 0;

const PROGRESS_INTERVAL_MS = 800;

export function delegateTool(ctx: ToolContext, extensions: ExtensionFactory[]): CustomTool<typeof DELEGATE_PARAMS> {
  return {
    name: "delegate",
    label: "派发子代理",
    description:
      "按 agent 定义启动只读子代理，返回结构化 findings JSON。model 可省；resources 的内容由服务端整份塞进子代理上下文，超过上限直接报错、不截断。子代理的工具面由 agent md 决定，review 没有读取工具。",
    parameters: DELEGATE_PARAMS,
    execute: async (_toolCallId, params, onUpdate, _ctx, signal) => {
      const agentName = (params.agent ?? "").trim();
      const roleName = (params.model ?? "").trim().replace(/^@/, "");
      const config = await loadConfig();
      const available = Object.keys(config.roles)
        .filter((role) => role !== "default")
        .map((role) => `@${role}`)
        .join("、");
      const spec = await loadAgent(agentName);
      const resources = (params.resources ?? []).slice(0, MAX_RESOURCES);
      const agentId = `${agentName}-${Date.now().toString(36)}-${++sequence}`;
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
      const base = {
        agent: agentName,
        agentId,
        ...(roleName === "" ? {} : { model: roleName }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(thinking === undefined ? {} : { thinking }),
        resources,
      };
      let lastInfo: SubagentInfo = {
        agentId,
        agent: agentName,
        status: "running",
        ...(roleName === "" ? {} : { model: roleName }),
        toolCount: 0,
        tokens: 0,
        cost: 0,
        durationMs: 0,
      };
      let lastSentAt = 0;
      let lastKey = "";
      const authStorage = await openAuthStorage(config.endpoints);
      try {
        const { settings, registry } = await openModelRuntime(authStorage, config.endpoints, config.roles);
        const mcpManager = ctx.mcpManager?.() ?? (await agentMcpManager());
        const repoRoot = existsSync(paths.repo) ? paths.repo : paths.root;
        const shared = [params.context, await prefetch(resources, ctx.sessionId)].filter(Boolean).join("\n\n");
        const artifacts = subagentDir(ctx.sessionId);
        await mkdir(artifacts, { recursive: true });
        onUpdate?.({ content: [], details: { ...base, subagent: lastInfo } });
        const result = await runSubprocess({
          cwd: repoRoot,
          additionalDirectories: [localDir(ctx.sessionId)],
          localProtocolOptions: {
            getArtifactsDir: () => artifactsDir(ctx.sessionId),
            getSessionId: () => ctx.sessionId,
          },
          agent: spec.agent,
          task: params.task,
          ...(shared === "" ? {} : { context: shared }),
          id: agentId,
          artifactsDir: artifacts,
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
          skills: [],
          preloadedCustomToolPaths: [],
          preloadedPreparedExtensions: extensions.map((factory, index) => ({
            path: `<cfpa-extension:${index}>`,
            resolvedPath: `<cfpa-extension:${index}>`,
            factory,
            error: null,
          })),
          ...(mcpManager === undefined ? { enableMCP: false } : { mcpManager }),
          signal,
          onProgress: (progress) => {
            const now = Date.now();
            if (now - lastSentAt < PROGRESS_INTERVAL_MS) return;
            const seen = `${progress.toolCount}|${progress.tokens}|${progress.currentTool ?? ""}|${progress.lastIntent ?? ""}`;
            if (seen === lastKey) return;
            lastSentAt = now;
            lastKey = seen;
            const activity = progress.currentToolIntent ?? progress.lastIntent ?? progress.currentTool;
            lastInfo = {
              agentId,
              agent: agentName,
              status: "running",
              ...(roleName === "" ? {} : { model: roleName }),
              ...(activity === undefined ? {} : { activity }),
              toolCount: progress.toolCount,
              tokens: progress.tokens,
              cost: progress.cost,
              durationMs: progress.durationMs,
              ...(progress.currentTool === undefined ? {} : { currentTool: progress.currentTool }),
              ...(progress.currentToolStartMs === undefined ? {} : { currentToolStartMs: progress.currentToolStartMs }),
              ...(progress.contextTokens === undefined ? {} : { contextTokens: progress.contextTokens }),
              ...(progress.contextWindow === undefined ? {} : { contextWindow: progress.contextWindow }),
            };
            onUpdate?.({ content: [], details: { ...base, subagent: lastInfo } });
          },
        });
        if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
          const text =
            result.error ??
            (signal?.aborted === true
              ? "主代理中止，子代理一起停了"
              : result.aborted
                ? "子代理已停止"
                : result.stderr.trim() || "子代理失败");
          return {
            content: [{ type: "text", text }],
            details: { ...base, subagent: { ...lastInfo, status: "error" } },
            isError: true,
          };
        }
        const data = result.structuredOutput?.data;
        return {
          content: [
            {
              type: "text",
              text: data === undefined ? result.output.trim() || "(子代理没有返回结果)" : JSON.stringify(data),
            },
          ],
          details: { ...base, subagent: { ...lastInfo, status: "done" } },
        };
      } finally {
        authStorage.close();
      }
    },
  };
}
