import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel as buildCatalogModel } from "@oh-my-pi/pi-catalog/build";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { LlmEndpoint, LlmProtocol } from "../../shared/api.ts";

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
  const spec: ModelSpec<Api> = {
    id: endpoint.model,
    name: endpoint.id,
    api: endpoint.protocol as Api,
    provider: endpoint.provider,
    baseUrl: normalizeBaseUrl(endpoint.baseUrl || defaultBaseUrl(endpoint.provider), endpoint.protocol),
    reasoning: reasoningOf(endpoint) !== undefined,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: endpoint.contextWindow ?? 128_000,
    maxTokens: endpoint.maxOutput ?? 8192,
  };
  return buildCatalogModel(spec);
}

export function reasoningOf(endpoint: LlmEndpoint): Effort | undefined {
  return endpoint.thinking && endpoint.thinking !== "off" ? (endpoint.thinking as Effort) : undefined;
}
