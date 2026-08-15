// src/client/llm-config-store.ts
// File persistence, merge, and validation for LLM endpoint config.
// Used by the admin API to read/save endpoint config.
// GET response never leaks key material.
// PUT uses blank-as-preserve semantics -- no sentinel/masked values.
// Supports backward-compatible storage: llm-endpoints.json may be either an
// array (legacy) or an object { endpoints, defaults? }.

import { LlmConfigManager } from "@/agent/llm-config-manager.js";
import {
  LLM_ENDPOINTS_JSON_PATH,
  parseLlmEndpoints,
  parseLlmDefaults,
} from "@/agent/llm-endpoints.js";
import {
  normalizeBaseUrlForProtocol,
  type LlmEndpoint,
  type LlmDefaults,
  type ThinkingLevel,
} from "@/agent/llm-types.js";
import { LlmConfigBodySchema } from "@/agent/llm-config-schema.js";
import { Value } from "typebox/value";
import { writeJsonFile } from "@/_shared/fs-utils.js";
/** Safe endpoint representation returned via GET.
 * `apiKey` is always empty string; `hasApiKey` indicates whether a key is stored
 * (never the key itself, its prefix, or any sentinel).
 */
export interface LlmEndpointSafe {
  provider: string;
  protocol?: string;
  baseUrl: string;
  apiKey: "";
  hasApiKey: boolean;
  modelId: string;
  inputLimit?: number;
  maxOutputTokens?: number;
}


/** Safe defaults representation returned via GET. */
export interface LlmDefaultsSafe {
  sessionModel?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };
  reviewModelSet?: Array<{ provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>;
}


/** Full GET response shape: endpoints (safe) + optional defaults. */
export interface LlmConfigResponse {
  endpoints: LlmEndpointSafe[];
  defaults?: LlmDefaultsSafe;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/** Runtime narrowing for the schema-validated body (endpoints elements are objects). */
function isLlmConfigBody(x: unknown): x is { endpoints: object[]; defaults?: unknown } {
  if (!x || typeof x !== "object" || Array.isArray(x) || !("endpoints" in x)) return false;
  const endpoints: unknown = x.endpoints;
  return Array.isArray(endpoints) && endpoints.every((e) => typeof e === "object" && e !== null);
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Load endpoints + defaults for GET response -- no key material exposed.
 * Each endpoint has apiKey set to "" and a hasApiKey boolean.
 */
export function loadConfig(): LlmConfigResponse {
  const endpoints = parseLlmEndpoints();
  const defaults = parseLlmDefaults();
  return {
    endpoints: endpoints.map((ep) => ({
      provider: ep.provider,
      protocol: ep.protocol,
      baseUrl: ep.baseUrl,
      apiKey: "",
      hasApiKey: ep.apiKey.length > 0,
      modelId: ep.modelId,
      inputLimit: ep.inputLimit,
      maxOutputTokens: ep.maxOutputTokens,
    })),
    defaults: defaults
      ? {
          ...(defaults.sessionModel ? { sessionModel: { ...defaults.sessionModel } } : {}),
          ...(defaults.reviewModelSet
            ? { reviewModelSet: defaults.reviewModelSet.map((m) => ({ ...m })) }
            : {}),
        }
      : undefined,
  };
}


/**
 * Validate, merge API keys, and persist endpoint config asynchronously.
 * Invalidates both endpoint cache and pi-ai registry on success.
 *
 * Rules:
 * - Blank apiKey preserves stored key for the same provider+modelId; rejects if no match.
 * - Non-blank apiKey replaces the stored key.
 * - Only LlmEndpoint fields are persisted; all UI-only or unknown fields are omitted.
 * - Empty array is valid (clears all endpoints).
 * - Object body: { endpoints: LlmEndpointInput[], defaults?: LlmDefaultsInput }.
 *   - Defaults (if present) must reference existing endpoints: sessionModel must match
 *     an endpoint; reviewModelSet must have >= 2 entries and each must match an endpoint.
 * - Body must be { endpoints: LlmEndpointInput[], defaults?: LlmDefaultsInput }.
 *
 * Writes object form { endpoints, defaults? } to disk (defaults only if set).
 */
export async function saveConfig(body: unknown): Promise<void> {
  // Stage 1 — structural validation (TypeBox schema): types, required fields,
  // protocol enum, positive-integer limits. Errors get precise instance paths.
  if (!Value.Check(LlmConfigBodySchema, body)) {
    const detail = Value.Errors(LlmConfigBodySchema, body)
      .slice(0, 5)
      .map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    throw new ConfigValidationError(`配置结构校验失败: ${detail}`);
  }
  if (!isLlmConfigBody(body)) {
    throw new ConfigValidationError("body must be an object: { endpoints: [], defaults?: {...} }");
  }
  const obj = body;

  // Stage 2 — business rules the schema cannot express: trim-to-empty
  // rejection, absolute-URL validity, defaults cross-references.
  const validated: object[] = [];
  for (const ep of obj.endpoints) {
    validateEndpoint(ep, validated.length);
    validated.push(ep);
  }
  // Check unique composite key: ${provider}:${modelId}
  const seen = new Set<string>();
  for (const ep of validated) {
    if ("provider" in ep && "modelId" in ep) {
      const key = `${String(ep.provider)}:${String(ep.modelId)}`;
      if (seen.has(key)) {
        throw new ConfigValidationError(`Duplicate endpoint: "${key}"`);
      }
      seen.add(key);
    }
  }
  // Validate defaults if present (must reference existing endpoints)
  let validatedDefaults: LlmDefaults | undefined;
  if (obj.defaults != null && typeof obj.defaults === "object" && !Array.isArray(obj.defaults)) {
    validatedDefaults = validateDefaults(obj.defaults as Record<string, unknown>, validated);
  }

  // Merge API keys with stored values and normalize to whitelist fields
  const stored = parseLlmEndpoints();
  const normalized = buildNormalizedEndpoints(validated, stored);

  // Build output shape
  const out: Record<string, unknown> = {
    endpoints: normalized,
  };
  if (validatedDefaults) {
    out.defaults = {
      ...(validatedDefaults.sessionModel
        ? {
            sessionModel: {
              provider: String(validatedDefaults.sessionModel.provider),
              modelId: String(validatedDefaults.sessionModel.modelId),
              ...(validatedDefaults.sessionModel.thinkingLevel != null
                ? { thinkingLevel: validatedDefaults.sessionModel.thinkingLevel }
                : {}),
            },
          }
        : {}),
      ...(validatedDefaults.reviewModelSet
        ? {
            reviewModelSet: validatedDefaults.reviewModelSet.map((m) => ({
              provider: String(m.provider),
              modelId: String(m.modelId),
              ...(m.thinkingLevel != null ? { thinkingLevel: m.thinkingLevel } : {}),
            })),
          }
        : {}),
    };
  }

  // 原子写 + Windows rename 重试(复用 fs-utils;失败自动清理临时文件)
  try {
    // API keys live in this file — keep it owner-readable on POSIX.
    await writeJsonFile(LLM_ENDPOINTS_JSON_PATH, out, { mode: 0o600 });
  } catch (err) {
    throw new Error(`Failed to write ${LLM_ENDPOINTS_JSON_PATH}: ${(err as Error).message}`);
  }

  // Invalidate both caches in one call.
  LlmConfigManager.getInstance().invalidate();
}

// ─── Validation ────────────────────────────────────────────────

/**
 * Validate defaults against a set of valid endpoint provider+modelId pairs.
 * Throws ConfigValidationError if any default reference is invalid.
 * @param defaults - the defaults object from the incoming body
 * @param validatedEndpoints - the already-validated incoming endpoint objects
 */
function validateDefaults(
  defaults: Record<string, unknown>,
  validatedEndpoints: object[],
): LlmDefaults {
  const result: LlmDefaults = {};

  // sessionModel (optional). Schema 已保证结构; 此处保留 trim 非空 +
  // 交叉引用 + thinkingLevel 过滤。
  if (defaults.sessionModel != null) {
    const sm = defaults.sessionModel as Record<string, unknown>;
    const provider = typeof sm.provider === "string" ? sm.provider.trim() : "";
    const modelId = typeof sm.modelId === "string" ? sm.modelId.trim() : "";
    if (!provider || !modelId) {
      throw new ConfigValidationError("defaults.sessionModel.provider and modelId must be non-empty");
    }
    if (!validatedEndpoints.some((e) => "provider" in e && "modelId" in e && e.provider === provider && e.modelId === modelId)) {
      throw new ConfigValidationError(`defaults.sessionModel references unknown endpoint "${provider}/${modelId}"`);
    }
    result.sessionModel = {
      provider,
      modelId,
      ...(sm.thinkingLevel != null && typeof sm.thinkingLevel === "string" && sm.thinkingLevel.length > 0
        ? { thinkingLevel: sm.thinkingLevel as ThinkingLevel }
        : {}),
    };
  }

  // reviewModelSet (optional) — must have >= 2, each must reference an endpoint
  if (defaults.reviewModelSet != null) {
    const arr = defaults.reviewModelSet as unknown[];
    if (arr.length < 2) {
      throw new ConfigValidationError("defaults.reviewModelSet must have at least 2 entries");
    }
    result.reviewModelSet = arr.map((item: unknown, idx: number) => {
      const obj = item as Record<string, unknown>;
      const provider = typeof obj.provider === "string" ? obj.provider.trim() : "";
      const modelId = typeof obj.modelId === "string" ? obj.modelId.trim() : "";
      if (!provider || !modelId) {
        throw new ConfigValidationError(`defaults.reviewModelSet[${idx}].provider and modelId must be non-empty`);
      }
      if (!validatedEndpoints.some((e) => "provider" in e && "modelId" in e && e.provider === provider && e.modelId === modelId)) {
        throw new ConfigValidationError(`defaults.reviewModelSet[${idx}] references unknown endpoint "${provider}/${modelId}"`);
      }
      return {
        provider,
        modelId,
        ...(obj.thinkingLevel != null && typeof obj.thinkingLevel === "string" && obj.thinkingLevel.length > 0
          ? { thinkingLevel: obj.thinkingLevel as ThinkingLevel }
          : {}),
      };
    });
  }

  return result;
}
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];



export function validateEndpoint(ep: object, index: number): void {
  // Schema 已保证类型/协议白名单/正整数; 此处保留 schema 表达不了的规则:
  // trim 后非空 + 绝对 URL 合法性。
  const provider = "provider" in ep && typeof ep.provider === "string" ? ep.provider.trim() : "";
  if (!provider) throw new ConfigValidationError(`Endpoint ${index}: provider is required`);

  const modelId = "modelId" in ep && typeof ep.modelId === "string" ? ep.modelId.trim() : "";
  if (!modelId) throw new ConfigValidationError(`Endpoint ${index}: modelId is required`);

  const baseUrl = "baseUrl" in ep && typeof ep.baseUrl === "string" ? ep.baseUrl.trim() : "";
  if (!baseUrl) throw new ConfigValidationError(`Endpoint ${index}: baseUrl is required`);

  // Validate absolute URL
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigValidationError(`Endpoint ${index}: baseUrl is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigValidationError(`Endpoint ${index}: baseUrl must be an absolute HTTP(S) URL`);
  }
}

// ─── Serialization ─────────────────────────────────────────────

/**
 * Pure: normalize a single validated endpoint to a whitelist of known LlmEndpoint fields.
 * - Trims provider/modelId/baseUrl
 * - Normalizes empty protocol to undefined (omitted from JSON)
 * - Numeric limits as numbers
 * - Resolves apiKey: blank preserves stored key for exact same composite identity
 *   (${provider}:${modelId}); rejects blank for new/renamed identities.
 * - Never includes hasApiKey, _-prefixed UI fields, or any unknown keys.
 */
function normalizeEndpoint(ep: object, storedApiKeyByKey: Map<string, string>): Record<string, unknown> {
  const provider = "provider" in ep ? String(ep.provider).trim() : "";
  const modelId = "modelId" in ep ? String(ep.modelId).trim() : "";
  const identity = `${provider}:${modelId}`;

  const rawApiKey = "apiKey" in ep ? String(ep.apiKey) : "";

  // Numeric limits
  let inputLimit: number | undefined;
  if ("inputLimit" in ep && ep.inputLimit != null) {
    const n = typeof ep.inputLimit === "number" ? ep.inputLimit : Number(ep.inputLimit);
    if (Number.isInteger(n) && n > 0) inputLimit = n;
  }
  let maxOutputTokens: number | undefined;
  if ("maxOutputTokens" in ep && ep.maxOutputTokens != null) {
    const n = typeof ep.maxOutputTokens === "number" ? ep.maxOutputTokens : Number(ep.maxOutputTokens);
    if (Number.isInteger(n) && n > 0) maxOutputTokens = n;
  }

  const rawProtocol = ("protocol" in ep && ep.protocol != null && String(ep.protocol).trim())
    ? String(ep.protocol).trim()
    : undefined;

  return {
    provider,
    modelId,
    baseUrl: normalizeBaseUrlForProtocol(
      "baseUrl" in ep ? String(ep.baseUrl).trim() : "",
      rawProtocol,
    ),
    apiKey: resolveApiKey(identity, rawApiKey, storedApiKeyByKey),
    ...(rawProtocol ? { protocol: rawProtocol } : {}),
    ...(inputLimit !== undefined ? { inputLimit } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

function resolveApiKey(identity: string, rawApiKey: string, storedApiKeyByKey: Map<string, string>): string {
  if (rawApiKey) {
    return rawApiKey;
  }
  const storedKey = storedApiKeyByKey.get(identity);
  if (storedKey !== undefined) {
    return storedKey;
  }
  throw new ConfigValidationError(
    `No stored API key found for "${identity}". Provide the API key or revert to the original provider/modelId.`,
  );
}

/**
 * Pure: build a whitelist-normalized endpoint array from validated incoming objects
 * and currently stored endpoints. No filesystem access — easily testable.
 *
 * @param validated - already-validated incoming endpoint objects
 * @param stored - current endpoints from disk cache
 * @returns normalized array suitable for JSON serialization
 */
export function buildNormalizedEndpoints(
  validated: object[],
  stored: LlmEndpoint[],
): Record<string, unknown>[] {

  const storedByKey = new Map<string, string>();
  for (const e of stored) {
    storedByKey.set(`${e.provider}:${e.modelId}`, e.apiKey);
  }

  return validated.map((ep) => normalizeEndpoint(ep, storedByKey));
}

