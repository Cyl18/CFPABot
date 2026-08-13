// src/client/llm-models.ts
// Server-side helper to discover model ids from an OpenAI-compatible `/models`
// endpoint. Pure URL-build + parse helpers are browser-safe too, but the actual
// HTTP fetch lives here (never the browser) so CORS is a non-issue for the
// admin "拉取端点模型" flow. Logic per AGENTS.md: HTTP to external → client/.

import type { LlmProtocol } from "../agent/llm-types.js";
export const MODELS_TIMEOUT_MS = 15_000;



/**
 * Endpoint suffixes to strip when normalizing an LLM baseUrl to its API root.
 * ORDER MATTERS: longest-first so `/chat/completions` is stripped before the
 * generic `/completions`. These are the only tails we remove — version segments
 * like `/v1`, `/v3`, `/api/coding/v3` are preserved (gateways such as
 * `https://ark.cn-beijing.volces.com/api/coding/v3` are roots, not endpoints).
 */
export const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/messages",
  "/responses",
  "/models",
] as const;

/**
 * Normalize an LLM baseUrl to its API root by stripping only endpoint suffixes
 * (and trailing slashes). Version segments (/v1, /v3, /api/coding/v3) and any
 * other path are preserved. Strips iteratively so a double-tailed input like
 * `.../v1/chat/completions/` collapses to the root in one call.
 *
 * Pure: does not mutate the input.
 */
export function normalizeLlmBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (url.toLowerCase().endsWith(suffix)) {
        url = url.slice(0, -suffix.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
  }
  return url;
}

/**
 * Infer the LLM protocol from a (possibly full, endpoint-tailed) URL, BEFORE
 * normalization strips the hints. Examines the path case-insensitively:
 *   - includes `/chat/completions`            → openai-completions
 *   - includes `/responses`                   → openai-responses
 *   - includes `/messages`                    → anthropic-messages
 *   - includes `/completions` (generic tail)  → openai-completions
 *   - generativelanguage.googleapis.com, `/v1beta`, or `gemini` → google-generative-ai
 *   - otherwise                               → undefined (leave to the user)
 *
 * Returns undefined (never a guess) when there is no recognizable keyword, so the
 * caller can let the user pick the protocol. Order matters: the more specific
 * `/chat/completions` is checked before the generic `/completions`.
 */
export function inferProtocolFromUrl(raw: string): LlmProtocol | undefined {
  const lower = raw.toLowerCase();
  if (lower.includes("/chat/completions")) return "openai-completions";
  if (lower.includes("/responses")) return "openai-responses";
  if (lower.includes("/messages")) return "anthropic-messages";
  if (lower.includes("/completions")) return "openai-completions";
  if (/generativelanguage\.googleapis\.com/.test(lower)) return "google-generative-ai";
  if (/\/v1beta/.test(lower)) return "google-generative-ai";
  if (/\bgemini\b/.test(lower)) return "google-generative-ai";
  return undefined;
}

/**
 * Build the provider /models URL for a baseUrl.
 *
 * OpenAI-family SDKs append the operation path to the stored root, so the root
 * keeps its version segment (`.../v1`) and the models URL is `.../v1/models`.
 * Anthropic is the exception: its SDK appends `/v1/messages` itself, so stored
 * roots have the `/v1` stripped at save time — re-add it here, otherwise the
 * probe hits `.../models` (no `/v1`), which gateways answer with HTML → the
 * JSON parse error users saw in the admin UI.
 */
export function buildModelsUrl(baseUrl: string, protocol?: LlmProtocol): string {
  const root = normalizeLlmBaseUrl(baseUrl);
  let apiRoot = root.replace(/\/+$/, "");
  if (protocol === "anthropic-messages" && !apiRoot.endsWith("/v1")) {
    apiRoot = `${apiRoot}/v1`;
  }
  if (apiRoot.endsWith("/models")) return apiRoot;
  return `${apiRoot}/models`;
}

interface NormalizedModels {
  data?: unknown[];
  models?: unknown[];
}

function normalize(json: unknown): NormalizedModels {
  if (!json || typeof json !== "object") return {};
  const obj = json as Record<string, unknown>;
  const out: NormalizedModels = {};
  if (Array.isArray(obj.data)) out.data = obj.data;
  if (Array.isArray(obj.models)) out.models = obj.models;
  return out;
}

/**
 * Parse a provider /models response flexibly. Accepts:
 *   - OpenAI style: `{ data: Array<{ id: string, ... }> }`
 *   - raw array of strings
 *   - array of objects with an `id` field
 *   - `{ models: [...] }` if present
 * Returns unique, non-empty string ids. Never throws.
 */
export function parseModelsResponse(json: unknown): string[] {
  const ids = new Set<string>();
  const addString = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) ids.add(v);
  };
  const addItem = (item: unknown) => {
    addString(item);
    if (item && typeof item === "object" && "id" in item) {
      addString((item as Record<string, unknown>).id);
    }
  };

  if (Array.isArray(json)) {
    json.forEach(addItem);
    return [...ids];
  }
  const norm = normalize(json);
  norm.data?.forEach(addItem);
  norm.models?.forEach(addItem);
  return [...ids];
}

/** Thrown when the caller supplies a rejected baseUrl/apiKey. */
export class ModelsProbeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsProbeValidationError";
  }
}

/** Thrown when the upstream /models call fails (network/timeout/non-OK). */
export class ModelsProbeUpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelsProbeUpstreamError";
  }
}

/** Validate baseUrl is a well-formed http(s) URL. Returns the parsed URL or throws. */
export function assertHttpBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ModelsProbeValidationError("baseUrl 不是有效的 URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ModelsProbeValidationError("baseUrl 仅支持 http(s) 协议");
  }
  return parsed;
}

/**
 * Fetch provider model ids through the backend.
 * Throws ModelsProbeValidationError on bad input, ModelsProbeUpstreamError on
 * upstream failure. apiKey is sent as a Bearer token; never logged.
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  protocol?: LlmProtocol,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = normalizeLlmBaseUrl(baseUrl);
  assertHttpBaseUrl(root);

  if (!apiKey || apiKey.trim().length === 0) {
    throw new ModelsProbeValidationError("缺少 apiKey");
  }

  const url = buildModelsUrl(root, protocol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  // Forward an external signal into our local controller.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new ModelsProbeUpstreamError(
      `无法连接端点: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ModelsProbeUpstreamError(
      `端点返回 HTTP ${res.status}`,
      res.status,
    );
  }

  // Some gateways answer 200 with an HTML page or empty body — that is an
  // upstream problem, not a client bug, so classify it as such (502) instead of
  // leaking a raw JSON SyntaxError (500) to the admin UI.
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ModelsProbeUpstreamError(
      `端点返回了非 JSON 响应 (HTTP ${res.status})`,
      res.status,
    );
  }

  const models = parseModelsResponse(json);
  if (models.length === 0) {
    throw new ModelsProbeUpstreamError(
      "响应中没有可识别的模型列表",
      res.status,
    );
  }
  return models;
}
