import type { LlmProtocol } from "@cfpa/contracts/api";
import { LLM_PROTOCOLS } from "@cfpa/contracts/api";

export const PROTOCOLS = LLM_PROTOCOLS.map((value) => ({ value, label: value }));

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
