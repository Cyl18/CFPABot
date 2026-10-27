import { type } from "@oh-my-pi/omptype";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CustomTool, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { AsyncJobError } from "@oh-my-pi/pi-coding-agent/async";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { startCompletionProbe } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SubagentInfo, ThinkingLevel } from "@cfpa/contracts/api";
import type { ToolContext } from "../context.ts";
import { loadConfig, resolveModel } from "../llm.ts";
import { parseRoleSelector } from "../llm-providers.ts";
import { paths } from "../../paths.ts";
import { lineRangeOf, sliceLines } from "../../harness/uri.ts";
import { MQM_TABLE } from "../../harness/review/workpack.ts";
import { artifactsDir, localDir, readLocal } from "../local-store.ts";
import { agentMcpManager } from "../mcp.ts";
import { openAuthStorage, openModelRuntime } from "../pi.ts";
import { noteSubagent, saveYield, subagentDir } from "../subagents.ts";

// 子代理的工具面由 agent md 的 tools 决定；孙代理由 omp 的 task 深度配置决定。

const AGENTS_DIR = join(paths.root, ".omp", "agents");

const AGENT_NAME = /^[A-Za-z0-9_-]+$/;
const PREFETCH_BYTES = 96_000;
const PREFETCH_TOTAL_BYTES = 192_000;
const MAX_RESOURCES = 12;
const SLICE_RESOURCE = /\/slices\/([^/]+)\.md$/;

/** 片 id 从 resources 文件名回推：pack 的 manifest 是唯一来源，这里只认它的命名。 */
function slicesOf(resources: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const uri of resources) {
    const match = SLICE_RESOURCE.exec(uri);
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  return [...ids];
}

const OPERATING_RULES = [
  "你是子代理：只做判断，一次交卷。",
  "- 上下文里已经放好主代理打包的分片：原文、译文、原始行、机械发现、术语表、旧线程、重复译文。不要自己去找输入。",
  "- 不调任何工具：片里的术语表是定译，照用；缺词或锁错写 termProposals。",
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
      systemPrompt: `${agent.systemPrompt.trim().replaceAll("{{MQM}}", MQM_TABLE)}\n\n${OPERATING_RULES}`,
    },
    output: agent.output,
  };
}

/** 预取只读资源：local:// 是打包分片，读不到或超限都直接报错；其它资源降级成截断与说明。 */
export async function prefetch(resources: readonly string[], sessionId: string): Promise<string> {
  if (resources.length === 0) return "";
  const blocks = await Promise.all(resources.map((uri) => readResource(uri, sessionId)));
  const joined = ["# 已预取资源", ...blocks].join("\n\n");
  if (Buffer.byteLength(joined) > PREFETCH_TOTAL_BYTES) {
    throw new Error(`预取总量超过 ${PREFETCH_TOTAL_BYTES} B；减少 resources 或拆片`);
  }
  return joined;
}

async function readResource(uri: string, sessionId: string): Promise<string> {
  const local = /^local:\/\//i.test(uri);
  try {
    const router = InternalUrlRouter.instance();
    const target = router.split(uri);
    const range = target.sel === undefined ? null : lineRangeOf(target.sel);
    // 本地分片走 readLocal：omp 的 local:// 只嗅前 8 KB，截断落在多字节字符中间会把整片判成二进制。
    const text = local
      ? (await readLocal(sessionId, target.path.replace(/^local:\/\//i, "")))?.content
      : (
          await router.resolve(target.path, {
            cwd: paths.root,
            localProtocolOptions: {
              getArtifactsDir: () => artifactsDir(sessionId),
              getSessionId: () => sessionId,
            },
          })
        ).content;
    if (text === undefined) throw new Error(`资源不存在：${uri}`);
    const content = range === null ? text : sliceLines(text, range);
    const bytes = Buffer.byteLength(content);
    if (bytes <= PREFETCH_BYTES) return `## 预取资源 ${uri}\n\n${content}`;
    // 子代理没有读取工具，截断等于让它审半份材料，所以整份分片必须装得下。
    if (local) throw new Error(`分片超过预取上限 ${PREFETCH_BYTES} B：${uri}（${bytes} B），重新打包成更小的片`);
    const head = Buffer.from(content).subarray(0, PREFETCH_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
    return `## 预取资源 ${uri}\n\n${head}\n…[预取已截断]`;
  } catch (err) {
    if (local) throw err;
    return `## 预取资源 ${uri} 失败\n\n${err instanceof Error ? err.message : String(err)}`;
  }
}

let sequence = 0;

const PROGRESS_INTERVAL_MS = 800;

export function delegateTool(ctx: ToolContext, extensions: ExtensionFactory[]): CustomTool<typeof DELEGATE_PARAMS> {
  return {
    name: "delegate",
    label: "派发子代理",
    description:
      "把一片任务交给子代理在后台跑，立即返回 agentId；结果自动投递，不要轮询，完全被挡住时才用 wait。model 可省；resources 的内容由服务端整份塞进子代理上下文，超过上限直接报错、不截断。子代理的工具面由 agent md 决定。",
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
      const slices = slicesOf(resources);
      const base = {
        agent: agentName,
        agentId,
        ...(roleName === "" ? {} : { model: roleName }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(thinking === undefined ? {} : { thinking }),
        resources,
        ...(slices.length === 0 ? {} : { slices }),
      };
      let lastInfo: SubagentInfo = {
        agentId,
        agent: agentName,
        status: "running",
        ...(roleName === "" ? {} : { model: roleName }),
        ...(slices.length === 0 ? {} : { slices }),
        toolCount: 0,
        tokens: 0,
        cost: 0,
        durationMs: 0,
      };
      let lastSentAt = 0;
      let lastKey = "";
      const publish = (info: SubagentInfo) => {
        lastInfo = info;
        noteSubagent(ctx.sessionId, info);
        ctx.emit?.({ type: "subagent", info });
      };
      const shared = [params.context, await prefetch(resources, ctx.sessionId)].filter(Boolean).join("\n\n");
      const artifacts = subagentDir(ctx.sessionId);
      await mkdir(artifacts, { recursive: true });
      const session = ctx.session?.();
      const manager = session?.asyncJobManager;

      const run = async (
        runSignal: AbortSignal,
        live: boolean,
        reportProgress?: (text: string, details?: Record<string, unknown>) => Promise<void>,
      ) => {
        const authStorage = await openAuthStorage(config.endpoints);
        const probeAbort = new AbortController();
        const stopProbe = () => probeAbort.abort();
        runSignal.addEventListener("abort", stopProbe, { once: true });
        try {
          const { settings, registry } = await openModelRuntime(authStorage, config.endpoints, config.roles);
          const mcpManager = ctx.mcpManager?.() ?? (await agentMcpManager());
          const repoRoot = existsSync(paths.repo) ? paths.repo : paths.root;
          startCompletionProbe({
            session: () => AgentRegistry.global().get(agentId)?.session ?? null,
            signal: AbortSignal.any([runSignal, probeAbort.signal]),
            onEstimate: (estimate, cost) => {
              publish({
                ...lastInfo,
                percent: estimate.percent,
                probeCost: (lastInfo.probeCost ?? 0) + cost,
                ...(estimate.stage === undefined ? {} : { stage: estimate.stage }),
                ...(estimate.watch === undefined ? {} : { watch: estimate.watch }),
              });
            },
          });
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
            detached: true,
            ...(modelOverride === undefined ? {} : { modelOverride }),
            structured: true,
            outputSchema: spec.output,
            authStorage,
            settings,
            modelRegistry: registry,
            ...(manager === undefined ? {} : { asyncJobManager: manager }),
            ...(session?.getAgentId() === undefined ? {} : { parentAgentId: session.getAgentId() }),
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
            // tools: [] 表示完全无工具，glossary MCP 也不给；子代理只读分片。
            ...(mcpManager === undefined || spec.agent.tools?.length === 0 ? { enableMCP: false } : { mcpManager }),
            signal: runSignal,
            onProgress: (progress) => {
              const now = Date.now();
              if (now - lastSentAt < PROGRESS_INTERVAL_MS) return;
              const seen = `${progress.toolCount}|${progress.tokens}|${progress.currentTool ?? ""}|${progress.lastIntent ?? ""}`;
              if (seen === lastKey) return;
              lastSentAt = now;
              lastKey = seen;
              const activity = progress.currentToolIntent ?? progress.lastIntent ?? progress.currentTool;
              publish({
                ...lastInfo,
                ...(activity === undefined ? {} : { activity }),
                toolCount: progress.toolCount,
                tokens: progress.tokens,
                cost: progress.cost,
                durationMs: progress.durationMs,
                ...(progress.currentTool === undefined ? {} : { currentTool: progress.currentTool }),
                ...(progress.currentToolStartMs === undefined ? {} : { currentToolStartMs: progress.currentToolStartMs }),
                ...(progress.contextTokens === undefined ? {} : { contextTokens: progress.contextTokens }),
                ...(progress.contextWindow === undefined ? {} : { contextWindow: progress.contextWindow }),
              });
              void reportProgress?.(activity ?? `${progress.toolCount} 次工具`, { subagent: lastInfo });
              if (live) onUpdate?.({ content: [], details: { ...base, subagent: lastInfo } });
            },
          });
          await saveYield(ctx.sessionId, agentId, result.structuredOutput?.data);
          return result;
        } finally {
          runSignal.removeEventListener("abort", stopProbe);
          stopProbe();
          authStorage.close();
        }
      };

      if (manager === undefined || session === undefined) {
        // 没有 job 管理器就只能同步跑；宁可慢，也不能把结果静默丢掉。
        const result = await run(signal ?? new AbortController().signal, true);
        const failed = result.aborted || result.exitCode !== 0 || result.error !== undefined;
        publish({ ...lastInfo, status: failed ? "error" : "done" });
        const data = result.structuredOutput?.data;
        const text = failed
          ? result.error ?? (result.aborted ? "子代理已停止" : result.stderr.trim() || "子代理失败")
          : data === undefined
            ? result.output.trim() || "(子代理没有返回结果)"
            : JSON.stringify(data);
        return {
          content: [{ type: "text", text }],
          details: { ...base, subagent: lastInfo },
          ...(failed ? { isError: true } : {}),
        };
      }

      const ownerId = session.getAgentId();
      const info: SubagentInfo = { ...lastInfo, jobId: agentId };
      publish(info);
      manager.register(
        "task",
        agentId,
        async ({ signal: jobSignal, reportProgress }) => {
          try {
            const result = await run(jobSignal, false, reportProgress);
            const structured = result.structuredOutput;
            if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
              throw new AsyncJobError(
                result.error ?? (result.aborted ? "子代理已停止" : result.stderr.trim() || "子代理失败"),
                structured,
              );
            }
            publish({ ...lastInfo, status: "done" });
            const data = structured?.data;
            return {
              text: data === undefined ? result.output.trim() || "(子代理没有返回结果)" : JSON.stringify(data),
              ...(structured === undefined ? {} : { structured }),
            };
          } catch (error) {
            publish({ ...lastInfo, status: "error" });
            throw error;
          }
        },
        { id: agentId, agentId, ...(ownerId === undefined ? {} : { ownerId }) },
      );
      onUpdate?.({ content: [], details: { ...base, subagent: info } });
      return {
        content: [
          {
            type: "text",
            text: `已派发 ${agentId}，后台运行中。结果会自动投递，不要轮询；完全被挡住时调用 wait。`,
          },
        ],
        details: { ...base, jobId: agentId, subagent: info },
      };
    },
  };
}
