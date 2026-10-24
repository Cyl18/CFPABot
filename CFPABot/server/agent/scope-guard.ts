import { join, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { WriteScope } from "@cfpa/contracts/api";
import { paths } from "../paths.ts";

const EXEC_TOOLS: Record<string, true> = { bash: true, eval: true };
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };
const READ_TOOLS: Record<string, true> = { read: true, grep: true, find: true, glob: true };
const LOCAL_URI = /^local:\/\//i;
const PR_URI = /^pr:\/\//i;
/** 内部 URL 由路由器解析，不是文件系统路径。 */
const SCHEME = /^[A-Za-z][\w+.-]*:\/\//;
/** read 的行号/raw 选择器尾部，`D:` 盘符不受影响。 */
const READ_SELECTOR = /(?::(?:raw|img|conflicts|\d[\d,+-]*|-\d+))+$/;
const EXEC_SOURCE: Record<string, string> = { bash: "command", eval: "code" };
/** `..` 作为独立路径段即拒；`...`、`a..b` 不算。 */
const PARENT_SEGMENT = /(?:^|[^A-Za-z0-9._-])\.\.(?:$|[^A-Za-z0-9._-])/;
/** 盘符与 MSYS 挂载点；必须行首或分隔符后，否则 `repo://`、`https://` 会被当成盘符。 */
const ABSOLUTE_PATH = /(?:^|[\s"'`(,=;|&])(?:[A-Za-z]:[\\/]|\/mnt\/)/;

/** 工具始终注册，关闭执行权限时在调用处拒绝，工具块因此恒定。 */
export function execBlockReason(toolName: string, allowed: boolean): string | undefined {
  if (EXEC_TOOLS[toolName] !== true || allowed) return undefined;
  return "执行权限已关闭（evalScope=off），管理员可在会话上开启。";
}

/** local:// 永远可写；GitHub 写入跟 writeScope 走；其余路径一律拒绝。 */
export function writeBlockReason(toolName: string, input: unknown, scope: WriteScope): string | undefined {
  if (WRITE_TOOLS[toolName] !== true) return undefined;
  const path = input && typeof input === "object" && "path" in input ? input.path : undefined;
  if (typeof path !== "string" || path.length === 0) return "写入需要明确的 local:// 或 pr:// 目标。";
  if (LOCAL_URI.test(path)) return undefined;
  if (PR_URI.test(path)) {
    return scope === "on" ? undefined : "写权限未开启（writeScope=off），管理员可在会话上开启。";
  }
  return "只能写 local://（会话 workspace）或 pr://（GitHub）。";
}

/** 会话 workspace 是 bash 与 eval 的 cwd，相对路径足够；`..` 与绝对路径直接拒绝。 */
export function execPathReason(toolName: string, input: unknown): string | undefined {
  const key = EXEC_SOURCE[toolName];
  if (key === undefined || input === null || typeof input !== "object") return undefined;
  const source = (input as Record<string, unknown>)[key];
  if (typeof source !== "string") return undefined;
  if (PARENT_SEGMENT.test(source)) return "只允许会话 workspace 内的相对路径，禁止 `..`；仓库文件用 `$CFPA_ROOT/…` 或 repo:// 读。";
  if (ABSOLUTE_PATH.test(source)) return "执行与写入只用相对路径，绝对路径一律拒绝；仓库用 `$CFPA_ROOT/…` 或 repo://，PR 文件先复制到 local://work/。";
  return undefined;
}

/** `path` 可能是字符串、数组，grep 还允许 `;` 分隔。 */
function pathEntries(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const raw = record.path ?? record.paths;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((item): item is string => typeof item === "string").flatMap((item) => item.split(";"));
}

/** 只读工具只能落在会话 workspace、runtime/work（仓库与 PR 物化）与 skills；内部 URL 放行。 */
export function readPathReason(toolName: string, input: unknown, workspace: string): string | undefined {
  if (READ_TOOLS[toolName] !== true) return undefined;
  const allowed = [workspace, join(paths.root, "runtime", "work"), join(paths.root, "skills")].map((dir) => resolve(dir));
  for (const entry of pathEntries(input)) {
    const target = entry.trim();
    if (target === "" || SCHEME.test(target)) continue;
    const relative = target.replace(READ_SELECTOR, "");
    const inside = [workspace, paths.root].some((base) => {
      const absolute = resolve(base, relative);
      return allowed.some((root) => absolute === root || absolute.startsWith(root + sep));
    });
    if (!inside) return `只读会话 workspace、runtime/work 与 skills；${target} 不在范围内。`;
  }
  return undefined;
}

export function scopeGuard(
  execAllowed: () => Promise<boolean>,
  writeScopeOf: () => Promise<WriteScope>,
  workspace: string,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const execReason = execBlockReason(event.toolName, await execAllowed());
      const writeReason =
        execReason === undefined ? writeBlockReason(event.toolName, event.input, await writeScopeOf()) : undefined;
      const pathReason = execReason === undefined ? execPathReason(event.toolName, event.input) : undefined;
      const readReason = readPathReason(event.toolName, event.input, workspace);
      const reason = execReason ?? writeReason ?? pathReason ?? readReason;
      return reason === undefined ? undefined : { block: true, reason };
    });
  };
}
