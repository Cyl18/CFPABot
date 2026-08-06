// src/agent/llm-registry.ts
// Project-level LLM model registry built on @earendil-works/pi-ai.
// Manages a Models collection that maps endpoint configs to pi-ai Model+Provider objects.
// Shared by Review Worker and Agent Session with lazy sync from JSON endpoint config.
//
// pi-ai API: createModels/createProvider from @earendil-works/pi-ai
// Lazy API factories: openAICompletionsApi, openAIResponsesApi,
//   anthropicMessagesApi, googleGenerativeAIApi from ./api/<id>.lazy
//
// Usage:
//   syncLlmRegistry(endpoints);          // initialise from config
//   const model = getLlmModel("openai", "gpt-4o");
//   const text = await llmComplete(model, sysPrompt, userMsg, { apiKey, signal, maxTokens });

import {
  createModels,
  createProvider,
  type MutableModels,
  type Model,
  type Api,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { normalizeLlmBaseUrl } from "../client/llm-models.js";
import { type LlmEndpoint, type ThinkingLevel, resolveProtocol } from "./llm-types.js";
import { LlmConfigManager } from "./llm-config-manager.js";

import type { SimpleStreamOptions, AssistantMessage } from "@earendil-works/pi-ai";

function manager(): LlmConfigManager {
  return LlmConfigManager.getInstance();
}

/** Compute a sync key from endpoints to detect changes. */
export function syncKey(endpoints: LlmEndpoint[]): string {
  return endpoints
    .map((e) => `${e.provider}\x00${e.modelId}\x00${e.baseUrl}\x00${e.protocol ?? ""}\x00${e.inputLimit ?? ""}\x00${e.maxOutputTokens ?? ""}\x00${!!e.apiKey}`)
    .join("|");
}

/** Map protocol id to its pi-ai API implementation factory. */
function getApiFactory(protocol: string): () => ProviderStreams {
  switch (protocol) {
    case "openai-completions":
      return () => openAICompletionsApi();
    case "openai-responses":
      return () => openAIResponsesApi();
    case "anthropic-messages":
      return () => anthropicMessagesApi();
    case "google-generative-ai":
      return () => googleGenerativeAIApi();
    default:
      throw new Error(`Unknown LLM protocol: ${protocol}`);
  }
}

// Protocol → endpoint path (appended by pi-ai SDKs at call time; we store only
// the normalized root in baseUrl, never the full chat/completions path):
//   openai-completions   → OpenAI SDK appends `/chat/completions`
//   openai-responses      → OpenAI SDK appends `/responses`
//   anthropic-messages    → Anthropic SDK appends `/v1/messages`
//   google-generative-ai  → Google GenAI uses baseUrl as-is (caller stores the
//                           versioned root, e.g. `.../v1beta`); apiVersion forced ""
// Do NOT strip version segments (/v1, /v3, /api/coding/v3) — they are part of the root.
// EXCEPTION: anthropic-messages appends `/v1/messages` itself, so a stored `.../v1`
// root would double to `/v1/v1/messages` — normalizeBaseUrlForProtocol strips the
// trailing `/v1` at parse/save time for that protocol.

/** Build a pi-ai Model from an LlmEndpoint. */
function buildPiModel(ep: LlmEndpoint, protocol: string): Model<Api> {
  return {
    id: ep.modelId,
    name: `${ep.provider}/${ep.modelId}`,
    api: protocol,
    provider: ep.provider,
    baseUrl: normalizeLlmBaseUrl(ep.baseUrl || `https://api.${ep.provider}.com/v1`),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ep.inputLimit ?? 128_000,
    maxTokens: ep.maxOutputTokens ?? 4096,
  } as Model<Api>;
}

/**
 * Pure: build (or rebuild) a pi-ai Models collection from endpoints.
 * Reuses `existing` when provided (mutating it in place) to preserve collection identity.
 * Returns the collection plus the sync key that produced it.
 */
export function buildModelsCollection(
  eps: LlmEndpoint[],
  existing?: MutableModels,
): { models: MutableModels; key: string } {
  const key = syncKey(eps);
  const models = existing ?? createModels();
  models.clearProviders();

  if (eps.length === 0) {
    return { models, key };
  }

  // Group endpoints by provider (one provider can serve multiple protocols)
  const byProvider: Record<string, LlmEndpoint[]> = {};
  for (const ep of eps) {
    (byProvider[ep.provider] ??= []).push(ep);
  }

  for (const providerId of Object.keys(byProvider)) {
    const pts = byProvider[providerId]!;
    // Collect all distinct protocols used by this provider's endpoints
    const apiMap: Record<string, ProviderStreams> = {};
    const piModels: Model<Api>[] = [];
    let baseUrl = pts[0]!.baseUrl;

    for (const ep of pts) {
      const proto = resolveProtocol(ep.provider, ep.protocol);
      if (!apiMap[proto]) {
        apiMap[proto] = getApiFactory(proto)();
      }
      piModels.push(buildPiModel(ep, proto));
      if (ep.baseUrl) baseUrl = ep.baseUrl;
    }

    const provider = createProvider({
      id: providerId,
      name: providerId,
      baseUrl,
      auth: { apiKey: { name: providerId, resolve: async () => ({ auth: {} }) } },
      models: piModels,
      api: apiMap,
    });
    models.setProvider(provider);
  }

  return { models, key };
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Synchronise the in-memory Models collection from the provided endpoints.
 * The collection is rebuilt only when endpoints differ from the last sync.
 * Call after config changes (e.g., after save in admin UI).
 * When called without arguments, reads from config/llm-endpoints.json.
 */
export function syncLlmRegistry(endpoints?: LlmEndpoint[]): MutableModels {
  return manager().syncModels(endpoints);
}

/**
 * Get pi-ai Model by provider + modelId from the current registry.
 * Lazily syncs from disk on first call if not yet initialised.
 */
export function getLlmModel(provider: string, modelId: string): Model<Api> | undefined {
  const models = manager().syncModels();
  return models.getModel(provider, modelId);
}

/** Invalidate the registry so next syncLlmRegistry() re-reads from disk/config. */


/**
 * Select the model for an agent session following priority:
 *  1. session.modelProvider + session.modelId (if resolvable)
 *  2. defaults.sessionModel (if resolvable)
 *  3. first endpoint in config
 *
 * Requires prior syncLlmRegistry() call — accesses internal Models collection via getLlmModel.
 */
export function selectSessionModel(
  sessionModelProvider: string | undefined,
  sessionModelId: string | undefined,
  endpoints: LlmEndpoint[],
): Model<Api> | undefined {
  // 1. Explicit session model
  if (sessionModelProvider && sessionModelId) {
    const m = getLlmModel(sessionModelProvider, sessionModelId);
    if (m) return m;
  }
  // 2. Configured default session model
  const defaults = manager().getDefaults();
  if (defaults?.sessionModel) {
    const { provider, modelId } = defaults.sessionModel;
    if (endpoints.some((e) => e.provider === provider && e.modelId === modelId)) {
      const m = getLlmModel(provider, modelId);
      if (m) return m;
    }
  }
  // 3. First endpoint fallback
  if (endpoints.length > 0) {
    return getLlmModel(endpoints[0]!.provider, endpoints[0]!.modelId);
  }
  return undefined;
}

/**
 * Validate that a modelProvider+modelId pair exists in the endpoint config.
 * Both modelProvider and modelId must be present when either is set.
 * Returns an error message string or null if valid.
 */
export function validateSessionModelPair(
  modelProvider: string | undefined,
  modelId: string | undefined,
  endpoints: LlmEndpoint[],
): string | null {
  if (!modelProvider && !modelId) return null;
  if (modelProvider && !modelId) return "modelId is required when modelProvider is set";
  if (!modelProvider && modelId) return "modelProvider is required when modelId is set";
  const exists = endpoints.some((e) => e.provider === modelProvider && e.modelId === modelId);
  return exists ? null : `Model ${modelProvider}/${modelId} not found in endpoint config`;
}

/**
 * LLM 调用失败: 透传上游 HTTP status 与服务端建议的重试时间。
 * 底层 SDK 错误(openai/anthropic APIError 等)携带 status + headers;
 * 保留它们让调用方(review_moa 的重试循环)做 429/5xx 感知的退避,
 * 而不是对所有错误一律立即重试。
 */
export class LlmCallError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmCallError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** 从 SDK 错误对象提取 HTTP status(存在且为整数时)。 */
function extractHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("status" in err)) return undefined;
  const status: unknown = err.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/** 从 SDK 错误对象的 headers 提取 retry-after(秒 → ms)。 */
function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("headers" in err)) return undefined;
  const headers: unknown = err.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const raw: unknown =
    "retry-after" in headers
      ? headers["retry-after"]
      : "Retry-After" in headers
        ? headers["Retry-After"]
        : undefined;
  if (typeof raw !== "string") return undefined;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Call an LLM with pi-ai and return the response text.
 * Uses the shared Models collection (must be initialised via syncLlmRegistry()).
 * Throws LlmCallError (non-abort) with sanitized message + upstream status.
 */
export async function llmComplete(
  model: Model<Api>,
  systemPrompt: string,
  userContent: string,
  options: {
    apiKey: string;
    signal?: AbortSignal;
    maxTokens?: number;
  },
): Promise<string> {
  const models = manager().syncModels();

  const streamOptions: SimpleStreamOptions = {
    apiKey: options.apiKey,
    signal: options.signal,
    maxTokens: options.maxTokens,
  };

  let response: AssistantMessage;
  try {
    response = await models.completeSimple(model, {
      systemPrompt,
      messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
    }, streamOptions);
  } catch (err: unknown) {
    // Preserve AbortError identity so callers can distinguish cancellation
    if (err instanceof Error && (err.name === "AbortError" || options.signal?.aborted)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmCallError(msg, {
      status: extractHttpStatus(err),
      retryAfterMs: extractRetryAfterMs(err),
      cause: err instanceof Error ? err : undefined,
    });
  }

  // Check for error in the response message
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    const errorMsg = response.errorMessage ?? "LLM call failed";
    if (response.stopReason === "aborted") {
      const abortError = new Error(errorMsg);
      abortError.name = "AbortError";
      throw abortError;
    }
    throw new Error(errorMsg);
  }

  // Extract text from content blocks
  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text) {
    throw new Error("LLM returned empty text content");
  }

  return text;
}

/**
 * Test an LLM endpoint by sending a minimal "你好" prompt and returning the reply.
 * Builds a fresh pi-ai collection from the raw endpoint config (independent of the
 * shared registry's sync state) so the test reflects exactly what is stored.
 * Throws a sanitized Error on upstream failure or timeout.
 */
export async function testLlmEndpoint(
  ep: LlmEndpoint,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const protocol = resolveProtocol(ep.provider, ep.protocol);
  const { models } = buildModelsCollection([ep]);
  const model = models.getModel(ep.provider, ep.modelId);
  if (!model) throw new Error("Failed to build model from endpoint config");

  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = AbortSignal.timeout(timeoutMs);

  let response: AssistantMessage;
  try {
    response = await models.completeSimple(
      model,
      {
        systemPrompt: "你是连接测试助手。",
        messages: [{ role: "user", content: "你好", timestamp: Date.now() }],
      },
      // Generous budget: reasoning models may consume most of it on thinking
      // before emitting the actual reply (observed: 64 tokens → only a thinking block).
      { apiKey: ep.apiKey, signal, maxTokens: 1024 },
    );
  } catch (err: unknown) {
    if (signal.aborted) {
      throw new Error(`测试超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "LLM 调用失败");
  }

  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) throw new Error("LLM 返回了空内容");
  return text;
}

/**
 * Test seam: replace the internal Models collection for injection testing.
 * Only intended for use in test files. Calling with null resets the collection.
 */
export function __setTestModels(models: MutableModels | null): void {
  manager().__setModelsForTest(models);
}
