import { join, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { logger } from "../../log.ts";
import { paths } from "../../paths.ts";

const log = logger("sandbox");

const EXEC_TOOLS: Record<string, true> = { bash: true, eval: true };
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };
const READ_TOOLS: Record<string, true> = { read: true, grep: true, find: true, glob: true };
const LOCAL_URI = /^local:\/\//i;
const PR_URI = /^pr:\/\//i;
const READ_SELECTOR = /(?::(?:raw|img|conflicts|\d[\d,+-]*|-\d+))+$/;
const EXEC_SOURCE: Record<string, string> = { bash: "command", eval: "code" };
const PARENT_SEGMENT = /(?:^|[^A-Za-z0-9._-])\.\.(?:$|[^A-Za-z0-9._-])/;
const ABSOLUTE_PATH = /(?:^|[\s"'`(,=;|&])(?:[A-Za-z]:[\\/]|\/(?!dev\/null\b)(?![/*]))/;
const RESERVED_REDIRECT = /(?:^|[\s;&|(])(?:\d|&)?>>?\s*["']?(?:nul|con|prn|aux|com[1-9]|lpt[1-9])(?:\.\w+)?["']?(?=$|[\s;&|)])/i;
// shortcut: 只挡 shell 重定向，eval 里 open("nul") 这类直接写文件不拦；等到真出现 eval 造设备名再扩。
const SECRET_FIELDS = ["path", "paths", "command", "code", "resources", "url"];
const ALLOWED_READ_SCHEMES: Record<string, true> = {
  repo: true,
  pr: true,
  gh: true,
  skill: true,
  local: true,
  artifact: true,
  agent: true,
};

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

export interface SandboxOptions {
  workspace: string;
  execAllowed: (toolName: string) => Promise<boolean>;
}

export function secretReason(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const text = SECRET_FIELDS.flatMap((field) => {
    const value = record[field];
    return Array.isArray(value) ? value : [value];
  })
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (text === "") return undefined;
  if (SECRET_NAMES.some((name) => text.includes(name))) return "禁止读取服务端密钥环境变量";
  if (SECRET_PATHS.some((pattern) => pattern.test(text))) return "禁止读取服务端配置文件";
  if (PRIVATE_PATHS.some((pattern) => pattern.test(text))) return "禁止读取服务端缓存、凭据或其它会话的数据";
  if (ENV_DUMPS.some((pattern) => pattern.test(text))) return "禁止枚举服务端环境变量";
  return undefined;
}

export function execReason(toolName: string, allowed: boolean): string | undefined {
  if (EXEC_TOOLS[toolName] !== true || allowed) return undefined;
  return `执行权限已关闭（${toolName === "bash" ? "bashScope" : "evalScope"}=off），管理员可在会话上开启。`;
}

export function writeReason(toolName: string, input: unknown): string | undefined {
  if (WRITE_TOOLS[toolName] !== true) return undefined;
  const path = input && typeof input === "object" && "path" in input ? input.path : undefined;
  if (typeof path !== "string" || path.length === 0) return "写入需要明确的 local:// 或 pr:// 目标。";
  if (LOCAL_URI.test(path) || PR_URI.test(path)) return undefined;
  return "只能写 local://（会话 workspace）或 pr://（GitHub）。";
}

export function execPathReason(toolName: string, input: unknown): string | undefined {
  const key = EXEC_SOURCE[toolName];
  if (key === undefined || input === null || typeof input !== "object") return undefined;
  const source = (input as Record<string, unknown>)[key];
  if (typeof source !== "string") return undefined;
  if (PARENT_SEGMENT.test(source)) return "只允许会话 workspace 内的相对路径，禁止 `..`；仓库文件用 `$CFPA_ROOT/…` 或 repo:// 读。";
  if (ABSOLUTE_PATH.test(source)) return "执行与写入只用相对路径，绝对路径一律拒绝；仓库用 `$CFPA_ROOT/…` 或 repo://，PR 文件先复制到 local://work/。";
  if (RESERVED_REDIRECT.test(source)) return "Windows 保留设备名不能当重定向目标；丢弃输出用 /dev/null。";
  return undefined;
}

function pathEntries(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const raw = record.path ?? record.paths;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((item): item is string => typeof item === "string").flatMap((item) => item.split(";"));
}

export function readPathReason(toolName: string, input: unknown, workspace: string): string | undefined {
  if (READ_TOOLS[toolName] !== true) return undefined;
  const allowed = [workspace, paths.work, join(paths.root, "skills")].map((dir) => resolve(dir));
  for (const entry of pathEntries(input)) {
    const target = entry.trim();
    if (target === "") continue;
    const scheme = /^([A-Za-z][\w+.-]*):\/\//.exec(target)?.[1]?.toLowerCase();
    if (scheme !== undefined) {
      if (ALLOWED_READ_SCHEMES[scheme] === true) continue;
      return `只允许读 repo://、pr://、gh://、skill://、artifact://、agent:// 与 local://；${target} 不在范围内。`;
    }
    const relative = target.replace(READ_SELECTOR, "");
    const inside = [workspace, paths.root].some((base) => {
      const absolute = resolve(base, relative);
      return allowed.some((root) => absolute === root || absolute.startsWith(root + sep));
    });
    if (!inside) return `只读会话 workspace、runtime/work 与 skills；${target} 不在范围内。`;
  }
  return undefined;
}

export function sandboxReason(
  toolName: string,
  input: unknown,
  workspace: string,
  execAllowed: boolean,
): string | undefined {
  const secret = secretReason(input);
  if (secret !== undefined) return secret;
  const exec = execReason(toolName, execAllowed);
  if (exec !== undefined) return exec;
  return writeReason(toolName, input) ?? execPathReason(toolName, input) ?? readPathReason(toolName, input, workspace);
}

export function sandbox(options: SandboxOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      let reason: string | undefined;
      try {
        reason = sandboxReason(
          event.toolName,
          event.input,
          options.workspace,
          await options.execAllowed(event.toolName),
        );
      } catch (err) {
        log.error("沙箱策略执行失败", { tool: event.toolName, err });
        reason = "沙箱策略执行失败，工具调用已拒绝。";
      }
      return reason === undefined ? undefined : { block: true, reason };
    });
  };
}
