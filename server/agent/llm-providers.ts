import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type ProviderStreams,
  type ThinkingLevel as PiThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { LlmEndpoint, LlmProtocol } from "../../shared/api.ts";

const FACTORIES: Record<LlmProtocol, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

export function endpointId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function normalizeBaseUrl(baseUrl: string, protocol: LlmProtocol): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return protocol === "anthropic-messages" ? trimmed.replace(/\/v1$/, "") : trimmed;
}

export function defaultBaseUrl(provider: string): string {
  return `https://api.${provider}.com/v1`;
}

export function buildModel(endpoint: LlmEndpoint): Model<Api> {
  return {
    id: endpoint.model,
    name: endpoint.id,
    api: endpoint.protocol,
    provider: endpoint.provider,
    baseUrl: normalizeBaseUrl(endpoint.baseUrl || defaultBaseUrl(endpoint.provider), endpoint.protocol),
    reasoning: reasoningOf(endpoint) !== undefined,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: endpoint.contextWindow ?? 128_000,
    maxTokens: endpoint.maxOutput ?? 8192,
  };
}

export function reasoningOf(endpoint: LlmEndpoint): PiThinkingLevel | undefined {
  return endpoint.thinking && endpoint.thinking !== "off" ? endpoint.thinking : undefined;
}

export function modelsSyncKey(endpoints: readonly LlmEndpoint[]): string {
  return endpoints
    .map((endpoint) =>
      [
        endpoint.provider,
        endpoint.model,
        normalizeBaseUrl(endpoint.baseUrl, endpoint.protocol),
        endpoint.protocol,
        endpoint.contextWindow ?? "",
        endpoint.maxOutput ?? "",
        endpoint.apiKey ? "1" : "0",
      ].join("\u0000"),
    )
    .join("|");
}

export function buildModels(endpoints: readonly LlmEndpoint[], existing?: MutableModels): MutableModels {
  const models = existing ?? createModels();
  models.clearProviders();
  const grouped = new Map<string, LlmEndpoint[]>();
  for (const endpoint of endpoints) {
    const list = grouped.get(endpoint.provider);
    if (list) list.push(endpoint);
    else grouped.set(endpoint.provider, [endpoint]);
  }
  for (const [provider, list] of grouped) {
    const api: Record<string, ProviderStreams> = {};
    for (const endpoint of list) api[endpoint.protocol] ??= FACTORIES[endpoint.protocol]();
    const first = list[0];
    if (!first) continue;
    models.setProvider(
      createProvider({
        id: provider,
        name: provider,
        baseUrl: normalizeBaseUrl(first.baseUrl || defaultBaseUrl(provider), first.protocol),
        auth: { apiKey: { name: provider, resolve: async () => ({ auth: {} }) } },
        models: list.map(buildModel),
        api,
      }),
    );
  }
  return models;
}
