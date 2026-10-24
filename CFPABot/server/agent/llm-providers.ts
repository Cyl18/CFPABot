import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel as buildCatalogModel } from "@oh-my-pi/pi-catalog/build";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { LLM_PROVIDER_PRESETS, type LlmEndpoint, type LlmProtocol, type ThinkingLevel } from "@cfpa/contracts/api";

const PRESET_BASE_URLS = new Map(LLM_PROVIDER_PRESETS.map((preset) => [preset.slug, preset.baseUrl]));

export { formatModelSelector as formatRoleSelector, parseModelSelector as parseRoleSelector } from "@cfpa/contracts/api";

export function endpointId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function normalizeBaseUrl(baseUrl: string, protocol: LlmProtocol): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return protocol === "anthropic-messages" ? trimmed.replace(/\/v1$/, "") : trimmed;
}

/** 存的可能是字面量，也可能是 `env:NAME` 引用；引用未设置按没有密钥处理。 */
export function resolveApiKey(stored: string): string | undefined {
  if (!stored.startsWith("env:")) return stored || undefined;
  return process.env[stored.slice(4).trim()]?.trim() || undefined;
}

export function defaultBaseUrl(provider: string): string {
  return PRESET_BASE_URLS.get(provider) ?? `https://api.${provider}.com/v1`;
}

export function buildModel(endpoint: LlmEndpoint, thinking?: ThinkingLevel): Model<Api> {
  const spec: ModelSpec<Api> = {
    id: endpoint.model,
    name: endpoint.id,
    api: endpoint.protocol as Api,
    provider: endpoint.provider,
    baseUrl: normalizeBaseUrl(endpoint.baseUrl || defaultBaseUrl(endpoint.provider), endpoint.protocol),
    reasoning: effortOf(thinking) !== undefined,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: endpoint.contextWindow ?? 128_000,
    maxTokens: endpoint.maxOutput ?? 8192,
  };
  return buildCatalogModel(spec);
}

export function effortOf(thinking?: ThinkingLevel): Effort | undefined {
  return thinking && thinking !== "off" ? (thinking as Effort) : undefined;
}
