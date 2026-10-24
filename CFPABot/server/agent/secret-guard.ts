import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";

const SECRET_NAMES = [
  "GITHUB_PAT",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "CURSEFORGE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "EXA_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "MISTRAL_API_KEY",
];

const SECRET_PATHS = [
  /config[\\/]llm\.json/i,
  /config[\\/]secret\.key/i,
  /config[\\/][^\\/]*\.(?:pem|key)/i,
  /(?:^|[\\/])\.env/i,
];

const PRIVATE_PATHS = [/runtime[\\/]cache[\\/]/i, /runtime[\\/]pi-agent[\\/]/i, /runtime[\\/]sessions[\\/]/i];

const ENV_DUMPS = [
  /\bprocess\.env\b/,
  /\bBun\.env\b/,
  /\bos\.environ\b/,
  /\bprintenv\b/,
  /\/proc\/self\/environ/,
  /"command"\s*:\s*"(?:[^"]*[;&|]\s*)?env(?:\s|")/,
];

export function secretViolation(input: unknown): string | undefined {
  const text = JSON.stringify(input);
  if (SECRET_NAMES.some((name) => text.includes(name))) return "禁止读取服务端密钥环境变量";
  if (SECRET_PATHS.some((pattern) => pattern.test(text))) return "禁止读取服务端配置文件";
  if (PRIVATE_PATHS.some((pattern) => pattern.test(text))) return "禁止读取服务端缓存、凭据或其它会话的数据";
  if (ENV_DUMPS.some((pattern) => pattern.test(text))) return "禁止枚举服务端环境变量";
  return undefined;
}

export const secretGuard: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event) => {
    const reason = secretViolation(event.input);
    return reason === undefined ? undefined : { block: true, reason };
  });
};
