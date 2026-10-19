import { join } from "node:path";
import { z } from "zod";
import type { Model, MutableModels, Api } from "@earendil-works/pi-ai";
import type {
  LlmConfig,
  LlmConfigUpdate,
  LlmConfigView,
  LlmEndpoint,
  ProbeModelsRequest,
} from "../../shared/api.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { readJson, writeJson } from "../store.ts";
import { probeModels } from "./llm-probe.ts";
import { buildModel, buildModels, defaultBaseUrl, endpointId, modelsSyncKey, normalizeBaseUrl, reasoningOf } from "./llm-providers.ts";

const log = logger("llm");
const CONFIG_PATH = join(paths.config, "llm.json");
const TEST_TIMEOUT_MS = 30_000;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const storedSchema = z.object({
  id: z.string().optional(),
  provider: z.string().min(1),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]),
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  thinking: z.enum(THINKING).optional(),
});

const configSchema = z.object({
  endpoints: z.array(storedSchema).default([]),
  agent: z.string().optional(),
  reviewers: z.array(z.string()).default([]),
});

let cache: LlmConfig | null = null;
let models: MutableModels | null = null;
let modelsKey = "";
let override: { collection: MutableModels; model: Model<Api> } | null = null;

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
    ...(raw.thinking ? { thinking: raw.thinking } : {}),
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
  cache = {
    endpoints: parsed.data.endpoints.map(normalizeEndpoint),
    ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
    reviewers: parsed.data.reviewers,
  };
  return cache;
}

export async function modelsCollection(): Promise<MutableModels> {
  if (override) return override.collection;
  const config = await loadConfig();
  const key = modelsSyncKey(config.endpoints);
  if (!models || key !== modelsKey) {
    models = buildModels(config.endpoints, models ?? undefined);
    modelsKey = key;
  }
  return models;
}

export async function resolveModel(
  id?: string,
): Promise<{ model: Model<Api>; apiKey: string | undefined; endpoint: LlmEndpoint | null }> {
  if (override && (!id || id === endpointId(override.model.provider, override.model.id))) {
    return { model: override.model, apiKey: undefined, endpoint: null };
  }
  const config = await loadConfig();
  const endpoint = id ? config.endpoints.find((e) => e.id === id) : config.endpoints.find((e) => e.id === config.agent);
  if (!endpoint) {
    throw new Error(id ? `未找到 LLM 端点 ${id}` : "未配置默认 LLM 端点（config/llm.json 的 agent 字段）");
  }
  const collection = await modelsCollection();
  const model = collection.getModel(endpoint.provider, endpoint.model);
  if (!model) throw new Error(`LLM 端点 ${endpoint.id} 未注册到模型集合`);
  return { model, apiKey: endpoint.apiKey || undefined, endpoint };
}

export function setModelsForTest(collection: MutableModels, model: Model<Api>): void {
  override = { collection, model };
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
      thinking: endpoint.thinking,
      hasKey: endpoint.apiKey.length > 0,
    })),
    agent: config.agent,
    reviewers: config.reviewers,
  };
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
          ...(raw.thinking ? { thinking: raw.thinking } : {}),
        }),
      );
    }
    const ids = new Set(endpoints.map((endpoint) => endpoint.id));
    if (input.agent && !ids.has(input.agent)) throw new Error(`agent 模型 ${input.agent} 不在端点列表中`);
    const reviewers = [...new Set(input.reviewers)];
    for (const reviewer of reviewers) {
      if (!ids.has(reviewer)) throw new Error(`reviewer 模型 ${reviewer} 不在端点列表中`);
    }
    const next: LlmConfig = { endpoints, ...(input.agent ? { agent: input.agent } : {}), reviewers };
    await writeJson(CONFIG_PATH, next, 0o600);
    cache = next;
    models = null;
    modelsKey = "";
    return toView(next);
  },

  async test(endpointIdToTest: string): Promise<{ ok: boolean; reply?: string; error?: string }> {
    const config = await loadConfig();
    const endpoint = config.endpoints.find((e) => e.id === endpointIdToTest);
    if (!endpoint) return { ok: false, error: `未找到端点 ${endpointIdToTest}` };
    const collection = buildModels([endpoint]);
    const model = collection.getModel(endpoint.provider, endpoint.model) ?? buildModel(endpoint);
    try {
      const response = await collection.completeSimple(
        model,
        {
          systemPrompt: "你是连接测试助手。",
          messages: [{ role: "user", content: "你好", timestamp: Date.now() }],
        },
        {
          apiKey: endpoint.apiKey || undefined,
          maxTokens: 1024,
          reasoning: reasoningOf(endpoint),
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
