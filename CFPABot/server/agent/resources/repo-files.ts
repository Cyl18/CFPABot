import { readdir, readFile, stat } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { mirror } from "../../mirror.ts";
import { repoRoot, resolveInside } from "../../workspace.ts";
import { jsonResult } from "../result.ts";
import { linesResult } from "./format.ts";
import type { RepoUri } from "./uri.ts";

const MAX_BYTES = 512 * 1024;
const DIR_LIMIT = 500;

async function listDir(root: string, rel: string): Promise<AgentToolResult<Record<string, unknown>>> {
  const abs = rel === "" ? root : resolveInside(root, rel);
  const entries = (await readdir(abs, { withFileTypes: true })).filter((entry) => entry.name !== ".git");
  const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
  return jsonResult({
    path: rel === "" ? "repo://" : `repo://${rel}`,
    entries: names.slice(0, DIR_LIMIT),
    total: names.length,
    ...(names.length > DIR_LIMIT ? { truncated: true } : {}),
  });
}

export async function readRepo(uri: RepoUri): Promise<AgentToolResult<Record<string, unknown>>> {
  const path = uri.path.trim();
  if (path.length === 0) return listDir(await repoRoot(), "");

  const ref = uri.query.get("ref");
  if (ref !== null && ref.length > 0) {
    const texts = await mirror.readMany(ref, [path]).catch((err: unknown) => {
      throw new Error(`无法读取 ${path} @ ${ref}：${err instanceof Error ? err.message : String(err)}`);
    });
    const text = texts.get(path);
    if (text === undefined) throw new Error(`文件不存在：repo://${path} @ ${ref}`);
    return jsonResult(linesResult(path, ref, text, uri.selector));
  }

  const root = await repoRoot();
  const abs = resolveInside(root, path);
  const info = await stat(abs).catch(() => null);
  if (info === null) throw new Error(`仓库文件不存在：repo://${path}`);
  if (info.isDirectory()) return listDir(root, path);
  if (info.size > MAX_BYTES) throw new Error(`文件过大（${info.size} 字节）：请用 :N-M 读取片段。`);
  return jsonResult(linesResult(path, "repo", await readFile(abs, "utf8"), uri.selector));
}
