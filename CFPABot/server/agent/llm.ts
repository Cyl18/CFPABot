import { join } from "node:path";
import { z } from "zod";
import { completeSimple, type Api, type Model } from "@oh-my-pi/pi-ai";
import type {
  LlmConfig,
  LlmConfigUpdate,
  LlmConfigView,
  LlmEndpoint,
  LlmReviewer,
  LlmSearch,
  ProbeModelsRequest,
  ThinkingLevel,
} from "../../shared/api.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { readJson, writeJson } from "../store.ts";
import { probeModels } from "./llm-probe.ts";
import { buildModel, defaultBaseUrl, endpointId, effortOf, normalizeBaseUrl } from "./llm-providers.ts";

const log = logger("llm");
const CONFIG_PATH = join(paths.config, "llm.json");
const TEST_TIMEOUT_MS = 30_000;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinkingSchema = z.enum(THINKING);
const reviewerSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), thinking: thinkingSchema.optional() }),
]);

const storedSchema = z.object({
  id: z.string().optional(),
  provider: z.string().min(1),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]),
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  thinking: thinkingSchema.optional(),
});

const searchSchema = z.object({
  provider: z.string().default(""),
  endpoint: z.string().default(""),
  apiKey: z.string().default(""),
});

const configSchema = z.object({
  endpoints: z.array(storedSchema).default([]),
  agent: z.string().optional(),
  agentThinking: thinkingSchema.optional(),
  reviewers: z.array(reviewerSchema).default([]),
  search: searchSchema.optional(),
});

let cache: LlmConfig | null = null;
let override: Model<Api> | null = null;

function normalizeEndpoint(raw: z.infer<typeof storedSchema>): LlmEndpoint {
  const provider = raw.provider.trim();
  const model = raw.model.trim();
  return {
    id: endpointId(provider, model),
    provider,
    protocol: raw.protocol,
    baseUrl: normalizeBaseUrl(raw.baseUrl || defaultBaseUrl(provider), raw.protocol),
    apiKey: raw.apiKey,
    model,
    ...(raw.contextWindow ? { contextWindow: raw.contextWindow } : {}),
    ...(raw.maxOutput ? { maxOutput: raw.maxOutput } : {}),
  };
}

export async function loadConfig(): Promise<LlmConfig> {
  if (cache) return cache;
  const raw = await readJson<unknown>(CONFIG_PATH);
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    log.warn("LLM 配置无法解析，按未配置处理", { path: CONFIG_PATH });
    cache = { endpoints: [], reviewers: [] };
    return cache;
  }
  const agent = parsed.data.agent;
  const legacyThinking = new Map(
    parsed.data.endpoints.map((raw) => [endpointId(raw.provider.trim(), raw.model.trim()), raw.thinking] as const),
  );
  const agentThinking = parsed.data.agentThinking ?? (agent ? legacyThinking.get(agent) : undefined);
  cache = {
    endpoints: parsed.data.endpoints.map(normalizeEndpoint),
    ...(agent ? { agent } : {}),
    ...(agentThinking ? { agentThinking } : {}),
    reviewers: parsed.data.reviewers.map((raw) => {
      const id = typeof raw === "string" ? raw : raw.id;
      const thinking = (typeof raw === "string" ? undefined : raw.thinking) ?? legacyThinking.get(id);
      return { id, ...(thinking ? { thinking } : {}) };
    }),
    ...(parsed.data.search && parsed.data.search.provider
      ? { search: { ...parsed.data.search, provider: parsed.data.search.provider.trim() } }
      : {}),
  };
  return cache;
}

export async function resolveModel(
  id?: string,
  thinkingOverride?: ThinkingLevel,
): Promise<{ model: Model<Api>; apiKey: string | undefined; endpoint: LlmEndpoint | null; thinking: ThinkingLevel | undefined }> {
  if (override && (!id || id === endpointId(override.provider, override.id))) {
    return { model: override, apiKey: undefined, endpoint: null, thinking: thinkingOverride };
  }
  const config = await loadConfig();
  const endpoint = id
    ? config.endpoints.find((e) => e.id === id)
    : config.endpoints.find((e) => e.id === config.agent) ?? config.endpoints[0];
  if (!endpoint) {
    throw new Error(id ? `未找到 LLM 端点 ${id}` : "尚未配置任何 LLM 端点");
  }
  const isDefault = config.agent ? endpoint.id === config.agent : endpoint.id === config.endpoints[0]?.id;
  const thinking = thinkingOverride ?? (isDefault ? config.agentThinking : undefined);
  return { model: buildModel(endpoint, thinking), apiKey: endpoint.apiKey || undefined, endpoint, thinking };
}

export function setModelForTest(model: Model<Api>): void {
  override = model;
}

function toView(config: LlmConfig): LlmConfigView {
  return {
    endpoints: config.endpoints.map((endpoint) => ({
      id: endpoint.id,
      provider: endpoint.provider,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      contextWindow: endpoint.contextWindow,
      maxOutput: endpoint.maxOutput,
      hasKey: endpoint.apiKey.length > 0,
    })),
    agent: config.agent,
    ...(config.agentThinking ? { agentThinking: config.agentThinking } : {}),
    reviewers: config.reviewers.map((reviewer) => ({ ...reviewer })),
    search:
      config.search === undefined
        ? null
        : { provider: config.search.provider, endpoint: config.search.endpoint, hasKey: config.search.apiKey.length > 0 },
  };
}

const SEARCH_ENV: Record<string, { key?: string; endpoint?: string }> = {
  searxng: { key: "SEARXNG_TOKEN", endpoint: "SEARXNG_ENDPOINT" },
  brave: { key: "BRAVE_API_KEY" },
  exa: { key: "EXA_API_KEY" },
  tavily: { key: "TAVILY_API_KEY" },
  jina: { key: "JINA_API_KEY" },
  firecrawl: { key: "FIRECRAWL_API_KEY" },
  parallel: { key: "PARALLEL_API_KEY" },
  kagi: { key: "KAGI_API_KEY" },
  kimi: { key: "KIMI_SEARCH_API_KEY", endpoint: "KIMI_SEARCH_BASE_URL" },
  deepseek: { key: "DEEPSEEK_API_KEY" },
  zai: { key: "ZAI_API_KEY" },
  perplexity: { key: "PERPLEXITY_API_KEY" },
  synthetic: { key: "SYNTHETIC_API_KEY" },
  tinyfish: { key: "TINYFISH_API_KEY" },
  ollama: { key: "OLLAMA_CLOUD_API_KEY" },
};

function nextSearch(current: LlmSearch | undefined, input: LlmConfigUpdate["search"]): LlmSearch | undefined {
  if (input === undefined) return current;
  if (input === null) return undefined;
  const provider = input.provider.trim();
  if (provider === "") return undefined;
  const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : current?.provider === provider ? current.apiKey : "";
  return { provider, endpoint: (input.endpoint ?? "").trim(), apiKey };
}

/** 搜索 provider 只认环境变量，建会话前把面板配置投影进去。 */
export function applySearchEnv(search: LlmSearch | undefined): void {
  for (const spec of Object.values(SEARCH_ENV)) {
    if (spec.key !== undefined) delete process.env[spec.key];
    if (spec.endpoint !== undefined) delete process.env[spec.endpoint];
  }
  if (search === undefined) return;
  const spec = SEARCH_ENV[search.provider];
  if (spec === undefined) return;
  if (spec.key !== undefined && search.apiKey !== "") process.env[spec.key] = search.apiKey;
  if (spec.endpoint !== undefined && search.endpoint !== "") process.env[spec.endpoint] = search.endpoint;
}

export const llm = {
  async view(): Promise<LlmConfigView> {
    return toView(await loadConfig());
  },

  async update(input: LlmConfigUpdate): Promise<LlmConfigView> {
    const current = await loadConfig();
    const stored = new Map(current.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    const endpoints: LlmEndpoint[] = [];
    for (const raw of input.endpoints) {
      const provider = raw.provider.trim();
      const model = raw.model.trim();
      if (!provider || !model) throw new Error("LLM 端点必须填写 provider 与 model");
      const id = endpointId(provider, model);
      const apiKey = raw.apiKey?.trim() ? raw.apiKey.trim() : stored.get(id)?.apiKey ?? "";
      endpoints.push(
        normalizeEndpoint({
          provider,
          model,
          protocol: raw.protocol,
          baseUrl: raw.baseUrl ?? "",
          apiKey,
          ...(raw.contextWindow ? { contextWindow: raw.contextWindow } : {}),
          ...(raw.maxOutput ? { maxOutput: raw.maxOutput } : {}),
        }),
      );
    }
    const ids = new Set(endpoints.map((endpoint) => endpoint.id));
    const agent = input.agent === undefined ? current.agent : input.agent.trim() || undefined;
    if (agent && !ids.has(agent)) throw new Error(`agent 模型 ${agent} 不在端点列表中`);
    const agentThinking = input.agentThinking === undefined ? current.agentThinking : input.agentThinking ?? undefined;
    const reviewers: LlmReviewer[] = [];
    const seen = new Set<string>();
    for (const raw of input.reviewers) {
      const id = raw.id.trim();
      if (!ids.has(id)) throw new Error(`reviewer 模型 ${id} 不在端点列表中`);
      if (seen.has(id)) continue;
      seen.add(id);
      reviewers.push({ id, ...(raw.thinking ? { thinking: raw.thinking } : {}) });
    }
    const search = nextSearch(current.search, input.search);
    const next: LlmConfig = {
      endpoints,
      ...(agent ? { agent } : {}),
      ...(agentThinking ? { agentThinking } : {}),
      reviewers,
      ...(search ? { search } : {}),
    };
    await writeJson(CONFIG_PATH, next, 0o600);
    cache = next;
    return toView(next);
  },

  async test(endpointIdToTest: string): Promise<{ ok: boolean; reply?: string; error?: string }> {
    const config = await loadConfig();
    const endpoint = config.endpoints.find((e) => e.id === endpointIdToTest);
    if (!endpoint) return { ok: false, error: `未找到端点 ${endpointIdToTest}` };
    const isDefault = config.agent ? endpoint.id === config.agent : endpoint.id === config.endpoints[0]?.id;
    const thinking = isDefault ? config.agentThinking : undefined;
    const model = buildModel(endpoint, thinking);
    try {
      const response = await completeSimple(
        model,
        {
          systemPrompt: ["你是连接测试助手。"],
          messages: [{ role: "user", content: "你好", timestamp: Date.now() }],
        },
        {
          apiKey: endpoint.apiKey || undefined,
          reasoning: effortOf(thinking),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return { ok: false, error: response.errorMessage ?? "调用失败" };
      }
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      return text ? { ok: true, reply: text } : { ok: false, error: "LLM 返回了空内容" };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `测试超时（${TEST_TIMEOUT_MS / 1000}s）` };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async probe(request: ProbeModelsRequest): Promise<string[]> {
    const config = await loadConfig();
    return probeModels(request, (id) => config.endpoints.find((e) => e.id === id)?.apiKey);
  },
};
