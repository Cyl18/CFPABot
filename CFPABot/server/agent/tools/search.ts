import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolContext } from "../context.ts";
import { localDir } from "../local-store.ts";
import { resolveToolPath } from "./fs.ts";

const PATH_HINT = "path 可写 local://、repo:// 或 pr://<n> 资源 URI，省略时用会话 workspace。";

/** 三个搜索工具共用：把 path 参数从 URI 解析成真实目录后交给内置实现。 */
function withUriPath<T extends object>(base: T, ctx: ToolContext): T {
  // 库的 ToolDefinition 泛型过深，这里只借用它的 execute 签名。
  const target = base as unknown as { execute: (...args: unknown[]) => unknown };
  return {
    ...base,
    execute: async (toolCallId: unknown, params: unknown, signal: unknown, onUpdate: unknown, runCtx: unknown) => {
      const input = params as { path?: string };
      return target.execute(
        toolCallId,
        { ...input, path: await resolveToolPath(ctx, input.path) },
        signal,
        onUpdate,
        runCtx,
      );
    },
  } as T;
}

export function grepTool(ctx: ToolContext) {
  const base = createGrepToolDefinition(localDir(ctx.sessionId));
  return withUriPath({ ...base, description: `${base.description} ${PATH_HINT}` }, ctx);
}

export function findTool(ctx: ToolContext) {
  const base = createFindToolDefinition(localDir(ctx.sessionId));
  return withUriPath({ ...base, description: `${base.description} ${PATH_HINT}` }, ctx);
}

export function lsTool(ctx: ToolContext) {
  const base = createLsToolDefinition(localDir(ctx.sessionId));
  return withUriPath({ ...base, description: `${base.description} ${PATH_HINT}` }, ctx);
}
