// PURE: LLM endpoint type definitions and pure helper functions.
// No I/O, no module-level mutable state.
export const KNOWN_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type LlmProtocol = (typeof KNOWN_PROTOCOLS)[number];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmEndpoint {
  provider: string;
  protocol?: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  inputLimit?: number;
  maxOutputTokens?: number;
}

export function endpointKey(e: { provider: string; modelId: string }): string {
  return `${e.provider}:${e.modelId}`;
}

/**
 * Protocol-aware baseUrl normalization.
 * OpenAI-family SDKs append the operation path (`/chat/completions`, `/responses`)
 * to the configured root, so a `.../v1` root is correct for them.
 * The Anthropic SDK appends `/v1/messages` itself — a stored `.../v1` root would
 * double to `/v1/v1/messages`, so the trailing `/v1` is stripped.
 * Google GenAI uses baseUrl as-is (caller stores the versioned root, e.g. `.../v1beta`).
 */
export function normalizeBaseUrlForProtocol(
  baseUrl: string,
  protocol: string | undefined,
): string {
  if (protocol === "anthropic-messages") {
    return baseUrl.replace(/\/v1\/?$/, "");
  }
  return baseUrl;
}

export interface LlmDefaults {
  sessionModel?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };
  reviewModelSet?: Array<{ provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>;
}

export interface LlmConfigFile {
  endpoints: LlmEndpoint[];
  defaults?: LlmDefaults;
}

const PROTOCOL_DEFAULTS: Record<string, LlmProtocol> = {
  openai: "openai-responses",
  anthropic: "anthropic-messages",
  google: "google-generative-ai",
};

export function resolveProtocol(provider: string, protocol?: string): LlmProtocol {
  if (protocol && isKnownProtocol(protocol)) return protocol;
  if (protocol && !isKnownProtocol(protocol)) {
    throw new Error(`Unknown protocol "${protocol}" for provider "${provider}"`);
  }
  return PROTOCOL_DEFAULTS[provider] ?? "openai-completions";
}

export function isKnownProtocol(value: string): value is LlmProtocol {
  return (KNOWN_PROTOCOLS as readonly string[]).includes(value);
}
