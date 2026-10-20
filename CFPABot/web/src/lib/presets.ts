import type { LlmProtocol } from "@shared/api.ts";

export interface ProviderPreset {
  slug: string;
  label: string;
  baseUrl: string;
  protocol: LlmProtocol;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { slug: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai-responses" },
  { slug: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic-messages" },
  { slug: "google", label: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", protocol: "google-generative-ai" },
  { slug: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", protocol: "openai-completions" },
  { slug: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai-completions" },
  { slug: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", protocol: "openai-completions" },
  { slug: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", protocol: "openai-completions" },
  { slug: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", protocol: "openai-completions" },
  { slug: "moonshot", label: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.cn/v1", protocol: "openai-completions" },
  { slug: "zhipu", label: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai-completions" },
  { slug: "opencode-go", label: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", protocol: "openai-completions" },
];

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
