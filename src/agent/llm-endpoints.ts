import { readFileSync } from "node:fs";

import type {
  LlmEndpoint,
  LlmProtocol,
  LlmDefaults,
  LlmConfigFile,
  ThinkingLevel,
} from "./llm-types.js";

import { isKnownProtocol, KNOWN_PROTOCOLS, normalizeBaseUrlForProtocol } from "./llm-types.js";
import { LlmConfigManager } from "./llm-config-manager.js";

function normalizeProtocol(raw: unknown): LlmProtocol | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (isKnownProtocol(raw)) return raw;
  throw new Error(`LLM endpoint: invalid protocol "${raw}". Must be one of: ${KNOWN_PROTOCOLS.join(", ")}`);
}

/** Path to the JSON endpoint config file (relative to project root). */
export const LLM_ENDPOINTS_JSON_PATH = "config/llm-endpoints.json";

function parseRawConfig(raw: string): LlmConfigFile {
  const parsed = JSON.parse(raw) as unknown;

  // Legacy array root
  if (Array.isArray(parsed)) {
    return {
      endpoints: parsed.map((e: Record<string, unknown>) => normalizeEndpointShape(e)),
    };
  }

  // Object form: { endpoints, defaults? }
  if (typeof parsed === "object" && parsed !== null && "endpoints" in parsed) {
    const obj = parsed as Record<string, unknown>;
    const endpointsRaw = obj.endpoints;
    if (!Array.isArray(endpointsRaw)) {
      throw new Error(`${LLM_ENDPOINTS_JSON_PATH}: "endpoints" 字段必须为数组`);
    }
    const endpoints = endpointsRaw.map((e: Record<string, unknown>) => normalizeEndpointShape(e));

    let defaults: LlmDefaults | undefined;
    if ("defaults" in obj && obj.defaults != null) {
      const d = obj.defaults as Record<string, unknown>;
      defaults = {};
      if (d.sessionModel != null) {
        const sm = d.sessionModel as Record<string, unknown>;
        defaults.sessionModel = {
          provider: String(sm.provider ?? ""),
          modelId: String(sm.modelId ?? ""),
          ...(sm.thinkingLevel != null && typeof sm.thinkingLevel === "string" && sm.thinkingLevel.length > 0
            ? { thinkingLevel: sm.thinkingLevel as ThinkingLevel }
            : {}),
        };
      }
      if (d.reviewModelSet != null) {
        const arr = d.reviewModelSet as unknown[];
        if (!Array.isArray(arr)) {
          throw new Error(`${LLM_ENDPOINTS_JSON_PATH}: "defaults.reviewModelSet" 必须为数组`);
        }
        defaults.reviewModelSet = arr.map((item: unknown) => {
          const obj = item as Record<string, unknown>;
          return {
            provider: String(obj.provider ?? ""),
            modelId: String(obj.modelId ?? ""),
            ...(obj.thinkingLevel != null && typeof obj.thinkingLevel === "string" && obj.thinkingLevel.length > 0
              ? { thinkingLevel: obj.thinkingLevel as ThinkingLevel }
              : {}),
          };
        });
      }
    }

    return { endpoints, defaults };
  }

  throw new Error(`${LLM_ENDPOINTS_JSON_PATH}: 配置格式无效 — 预期数组或 { endpoints, defaults? } 对象`);
}

function normalizeEndpointShape(e: Record<string, unknown>): LlmEndpoint {
  const protocol = normalizeProtocol(e.protocol);
  return {
    provider: String(e.provider ?? ""),
    protocol,
    baseUrl: normalizeBaseUrlForProtocol(String(e.baseUrl ?? ""), protocol),
    apiKey: String(e.apiKey ?? ""),
    modelId: String(e.modelId ?? ""),
    ...(typeof e.inputLimit === "number" && e.inputLimit > 0
      ? { inputLimit: e.inputLimit }
      : {}),
    ...(typeof e.maxOutputTokens === "number" && e.maxOutputTokens > 0
      ? { maxOutputTokens: e.maxOutputTokens }
      : {}),
  };
}

/**
 * Read endpoints + defaults from disk WITHOUT caching.
 * Returns `{ endpoints: [], defaults: undefined }` when the config file is missing
 * (ENOENT) — a valid state meaning "no LLM configured".
 */
export function readEndpointsFromDisk(): {
  endpoints: LlmEndpoint[];
  defaults: LlmDefaults | null | undefined;
} {
  let raw: string;
  try {
    raw = readFileSync(LLM_ENDPOINTS_JSON_PATH, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { endpoints: [], defaults: undefined };
    }
    throw err;
  }

  const config = parseRawConfig(raw);
  return { endpoints: config.endpoints, defaults: config.defaults ?? null };
}

function manager(): LlmConfigManager {
  return LlmConfigManager.getInstance();
}

/** Parse all LLM endpoint configs from config/llm-endpoints.json. Cached after first call. */
export function parseLlmEndpoints(): LlmEndpoint[] {
  return manager().getEndpoints();
}

/**
 * Parse the defaults section from llm-endpoints.json. Returns defaults if configured,
 * null if config has no defaults, undefined if not yet parsed.
 * Cached after first call alongside parseLlmEndpoints().
 */
export function parseLlmDefaults(): LlmDefaults | null {
  return manager().getDefaults();
}

/** Invalidate the cached endpoint list so the next parseLlmEndpoints() re-reads from disk. */

/**
 * Find an endpoint by provider + modelId.
 *
 * Returns undefined if no matching endpoint is found.
 */
export function findLlmEndpoint(
  provider: string,
  modelId: string,
): LlmEndpoint | undefined {
  const eps = parseLlmEndpoints();
  return eps.find((e) => e.provider === provider && e.modelId === modelId);
}

/** Test seam
 * Test seam: inject endpoint list into the cache, bypassing filesystem read.
 * Only intended for use in test files. Call with null or [] to reset.
 */
export function __setTestEndpoints(endpoints: LlmEndpoint[] | null): void {
  manager().__setEndpointsForTest(endpoints);
}

/**
 * Test seam: inject defaults into the cache, bypassing filesystem read.
 * Only intended for use in test files. Call with null to clear defaults,
 * undefined to restore file-based parsing.
 */
export function __setTestDefaults(defaults: LlmDefaults | null | undefined): void {
  manager().__setDefaultsForTest(defaults);
}
