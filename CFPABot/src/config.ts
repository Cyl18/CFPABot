// src/config.ts
// Loads entry layer configuration from environment variables + constants.
// Runtime validation with TypeBox — fails fast with clear error messages on missing/invalid vars.

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { readFile } from "node:fs/promises";
import { ensurePiRuntimeEnv } from "./runtime-paths.js";

// pi-agent 配置环境：项目内 config/pi-agent（git 跟踪），与构建 agent（opencode/omp 根 .mcp.json）分离。
// pi-coding-agent 的 getAgentDir() 与 pi-mcp-adapter 的 getAgentDir() 均读 PI_CODING_AGENT_DIR。
// glossary 二进制目录：本机 runtime/bin（脚本下载），Docker 镜像 /app/bin（Dockerfile ENV 覆盖）。
// 路径常量与 env 初始化统一在 src/runtime-paths.ts。
ensurePiRuntimeEnv();

export const REPO = {
  OWNER: "CFPAOrg",
  NAME: "Minecraft-Mod-Language-Package",
  ID: 88008282,
  BASE_URL: "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package",
  DEFAULT_BRANCH: "main",
  PR_PACKER_FILE: "pr-packer.yml",
} as const;

export const AUTH = {
  OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID ?? "",
  OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET ?? "",
  OAUTH_TOKEN_COOKIE_NAME: "oauth-token-enc",
  OAUTH_SCOPES: "user:email public_repo workflow",
  OAUTH_AUTHORIZE_URL: "https://github.com/login/oauth/authorize",
  OAUTH_TOKEN_URL: "https://github.com/login/oauth/access_token",
  COOKIE_MAX_AGE_DAYS: 7,
} as const;

/** Cache schema version. Bump when cache JSON structure changes. */
export const CACHE_VERSION = 1;

export { REQUIRED_DIRS } from "./runtime-paths.js";

/** Bot login for finding existing bot comments on PRs. */
export const BOT_LOGIN = "cfpa-bot[bot]";

/** Labels that should block PR merging — configured per spec §6 §2. */
export const FORBIDDEN_LABELS = new Set([
  "NO-MERGE",
  "needs author action",
  "changes required",
  "ready to reject",
  "即将被搁置",
  "即将拒收",
]);

/** The complete set of labels the bot manages — used by labels_sync to
 *  distinguish owned labels from manual or other-automation labels.
 *  Only labels in this set are ever removed by the bot. */
export const MANAGED_LABELS = new Set([
  "1+", "10+", "40+", "100+", "500+", "1000+", "2000+", "5000+",
  "config", "source",
]);

/** Size label thresholds (inclusive lower bound, inclusive upper bound).
 *  A total change count belongs to exactly one bucket — the first whose
 *  range contains it. */
export const SIZE_LABEL_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1+", min: 0, max: 9 },
  { label: "10+", min: 10, max: 39 },
  { label: "40+", min: 40, max: 99 },
  { label: "100+", min: 100, max: 499 },
  { label: "500+", min: 500, max: 999 },
  { label: "1000+", min: 1000, max: 1999 },
  { label: "2000+", min: 2000, max: 4999 },
  { label: "5000+", min: 5000, max: Infinity },
];

/** Path prefix → label mapping. A PR changing files under a prefix gets the
 *  corresponding label. Prefixes are checked via startsWith. */
export const PATH_LABEL_MAP: Record<string, string> = {
  "config/": "config",
  "src/": "source",
};

// Env vars are strings on disk; numeric fields validate their string form
// with a positive-integer pattern, then convert via Number() in the mapping
// below. Unknown env keys are allowed (JSON Schema default).
const configSchema = Type.Object({
  GITHUB_OAUTH_TOKEN: Type.Optional(Type.String()),
  GITHUB_WEBHOOK_SECRET: Type.String({ minLength: 1 }),
  GITHUB_APP_ID: Type.String({ minLength: 1, pattern: "^[1-9][0-9]*$" }),
  GITHUB_APP_PEM_PATH: Type.Optional(Type.String()),
  GITHUB_APP_INSTALLATION_ID: Type.String({ minLength: 1, pattern: "^[1-9][0-9]*$" }),
  OAUTH_CLIENT_ID: Type.Optional(Type.String()),
  OAUTH_CLIENT_SECRET: Type.Optional(Type.String()),
  PORT: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$" })),
  ASPNETCORE_ENVIRONMENT: Type.Optional(Type.Union([Type.Literal("Development"), Type.Literal("Production")])),
  LOG_LEVEL: Type.Optional(Type.Union([Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")])),
  /** 审查发表总开关: false 时 review_comment 直接拒绝(仅产生审查结果, 不写 GitHub)。 */
  REVIEW_PUBLISH_ENABLED: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
});

export interface EntryConfig {
  owner: string;
  repoName: string;
  repoId: number;
  repoUrl: string;
  defaultBranch: string;
  webhookSecret: string;
  /** Optional PAT fallback (deprecated, prefer GitHub App) */
  personalAccessToken: string;
  /** GitHub App ID for JWT authentication */
  githubAppId: number;
  /** Path to GitHub App PEM private key */
  githubAppPemPath: string;
  /** GitHub App Installation ID */
  githubAppInstallationId: number;
  port: number;
  environment: "development" | "production";
  logLevel: Static<typeof configSchema>["LOG_LEVEL"];
  oauthClientId: string;
  oauthTokenCookieName: string;
  /** GitHub App PEM private key (loaded from disk at startup) */
  pemKey: string;
  /** 审查发表总开关(REVIEW_PUBLISH_ENABLED): false 时 review_comment 直接拒绝。 */
  reviewPublishEnabled: boolean;
}

export function loadEntryConfigSync(): Omit<EntryConfig, "pemKey"> {
  if (!Value.Check(configSchema, process.env)) {
    const issues = [...Value.Errors(configSchema, process.env)]
      .map((e) => `  - ${e.instancePath.replace(/^\//, "") || "(root)"}: ${e.message}`)
      .join("\n");
    throw new Error(`配置验证失败:\n${issues}`);
  }

  // Schema passed — parse is safe, types come from Static<typeof configSchema>.
  const env = Value.Parse(configSchema, process.env);

  return {
    owner: REPO.OWNER,
    repoName: REPO.NAME,
    repoId: REPO.ID,
    repoUrl: REPO.BASE_URL,
    defaultBranch: REPO.DEFAULT_BRANCH,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    personalAccessToken: env.GITHUB_OAUTH_TOKEN ?? "",
    githubAppId: Number(env.GITHUB_APP_ID),
    githubAppPemPath: env.GITHUB_APP_PEM_PATH ?? "config/cfpa-bot.pem",
    githubAppInstallationId: Number(env.GITHUB_APP_INSTALLATION_ID),
    logLevel: env.LOG_LEVEL ?? "info",
    port: env.PORT !== undefined ? Number(env.PORT) : 8080,
    environment: env.ASPNETCORE_ENVIRONMENT === "Development" ? "development" : "production",
    oauthClientId: env.OAUTH_CLIENT_ID ?? "",
    oauthTokenCookieName: AUTH.OAUTH_TOKEN_COOKIE_NAME,
    reviewPublishEnabled: env.REVIEW_PUBLISH_ENABLED === "true",
  };
}

export async function loadEntryConfig(): Promise<EntryConfig> {
  const base = loadEntryConfigSync();

  // Load GitHub App PEM private key
  let pemKey: string;
  try {
    pemKey = await readFile(base.githubAppPemPath, "utf-8");
  } catch {
    throw new Error(`无法读取 GitHub App 私钥: ${base.githubAppPemPath}（请确认文件存在）`);
  }

  return { ...base, pemKey };
}
