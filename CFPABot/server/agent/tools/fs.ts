import { prdata } from "../../prdata.ts";
import { ensurePrDir, repoRoot, resolveInside } from "../../workspace.ts";
import type { ToolContext } from "../context.ts";
import { localDir } from "../local-store.ts";
import { parseUri } from "../resources/uri.ts";

/** 把工具参数里的路径解析成真实目录：支持 repo:// / pr:// / local:// 与 local 相对路径。 */
export async function resolveToolPath(ctx: ToolContext, input: string | undefined): Promise<string> {
  const local = localDir(ctx.sessionId);
  const trimmed = input?.trim() ?? "";
  if (trimmed === "" || trimmed === ".") return local;
  if (!trimmed.includes("://")) return resolveInside(local, trimmed);

  const uri = parseUri(trimmed);
  if (uri.scheme === "local") return uri.path === "" ? local : resolveInside(local, uri.path);
  if (uri.scheme === "repo") return resolveInside(await repoRoot(), uri.path);
  if (uri.scheme === "pr") {
    const headSha =
      ctx.prNumber === uri.number && ctx.headSha !== null
        ? ctx.headSha
        : (await prdata.files(uri.number)).pull.headSha;
    return resolveInside(await ensurePrDir(uri.number, headSha), uri.path);
  }
  throw new Error(`${uri.scheme}:// 不是文件资源，不能用这个工具访问。`);
}
