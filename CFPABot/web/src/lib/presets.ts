import type { LlmProtocol } from "@shared/api.ts";
import { LLM_PROVIDER_PRESETS } from "@shared/api.ts";

export type ProviderPreset = (typeof LLM_PROVIDER_PRESETS)[number];

export const PROVIDER_PRESETS = LLM_PROVIDER_PRESETS;

export const PROTOCOLS: readonly { value: LlmProtocol; label: string }[] = [
  { value: "openai-completions", label: "openai-completions" },
  { value: "openai-responses", label: "openai-responses" },
  { value: "anthropic-messages", label: "anthropic-messages" },
  { value: "google-generative-ai", label: "google-generative-ai" },
];

const TRAILING_SUFFIXES = ["/chat/completions", "/completions", "/messages", "/responses", "/models"];

export function normalizeLlmBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of TRAILING_SUFFIXES) {
      if (url.endsWith(suffix)) {
        url = url.slice(0, -suffix.length).replace(/\/+$/, "");
        stripped = true;
      }
    }
  }
  return url;
}

export function inferProtocolFromUrl(url: string): LlmProtocol | undefined {
  if (/\/(chat\/completions|completions)$/.test(url)) return "openai-completions";
  if (/\/responses$/.test(url)) return "openai-responses";
  if (/\/messages$/.test(url)) return "anthropic-messages";
  if (/generativelanguage\.googleapis\.com|\/v1beta$|gemini/i.test(url)) return "google-generative-ai";
  return undefined;
}

export function endpointId(provider: string, model: string): string {
  return `${provider}/${model}`;
}
