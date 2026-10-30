import { join } from "node:path";
import { z } from "zod";

// 项目级 omp 配置跟着 config/ 走，镜像里不必再带一个 .omp 目录。
process.env.PI_CONFIG_FILES ||= join(process.cwd(), "config", "omp.yml");

// 容器里 locale 就是 UTF-8，只有 Windows 缺 PYTHONUTF8 才需要这个兜底。
if (process.platform === "win32") {
  process.env.PYTHONPATH = [join(import.meta.dir, "eval-boot"), process.env.PYTHONPATH].filter(Boolean).join(";");
}

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PUBLIC_URL: z.string().default("http://localhost:5173").transform((v) => v.replace(/\/+$/, "")),
  GITHUB_REPO: z
    .string()
    .default("CFPAOrg/Minecraft-Mod-Language-Package")
    .refine((v) => /^[\w.-]+\/[\w.-]+$/.test(v), "must be owner/name"),
  GITHUB_APP_ID: optional,
  GITHUB_APP_INSTALLATION_ID: optional,
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default("config/app.pem"),
  GITHUB_WEBHOOK_SECRET: optional,
  GITHUB_OAUTH_CLIENT_ID: optional,
  GITHUB_OAUTH_CLIENT_SECRET: optional,
  GITHUB_PAT: optional,
  BOT_LOGIN: z.string().default("cfpa-bot[bot]"),
  CURSEFORGE_API_KEY: optional,
  DEV_LOGIN: optional,
  DEV_GITHUB_TOKEN: optional,
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`环境变量无效:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export const env = load();

const [owner, name] = env.GITHUB_REPO.split("/") as [string, string];
export const repo = { owner, name, fullName: env.GITHUB_REPO, defaultBranch: "main" } as const;

export const isDev = env.NODE_ENV !== "production";
