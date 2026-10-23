import { readdir, readFile, stat } from "node:fs/promises";
import { mirror } from "../../mirror.ts";
import { repoRoot, resolveInside } from "../../workspace.ts";
import type { ResourceParts } from "./uri.ts";

const MAX_BYTES = 512 * 1024;
const DIR_LIMIT = 500;

async function listDir(root: string, rel: string): Promise<string> {
  const abs = rel === "" ? root : resolveInside(root, rel);
  const entries = (await readdir(abs, { withFileTypes: true })).filter((entry) => entry.name !== ".git");
  const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
  const shown = names.slice(0, DIR_LIMIT);
  if (names.length > DIR_LIMIT) shown.push(`…共 ${names.length} 项，已截断`);
  return shown.join("\n");
}

export async function readRepo(parts: ResourceParts): Promise<{ text: string; isDirectory?: boolean }> {
  const path = parts.path.trim();
  if (path.length === 0) return { text: await listDir(await repoRoot(), ""), isDirectory: true };

  const ref = parts.query.get("ref");
  if (ref !== null && ref.length > 0) {
    const texts = await mirror.readMany(ref, [path]).catch((err: unknown) => {
      throw new Error(`无法读取 ${path} @ ${ref}：${err instanceof Error ? err.message : String(err)}`);
    });
    const text = texts.get(path);
    if (text === undefined) throw new Error(`文件不存在：repo://${path} @ ${ref}`);
    return { text };
  }

  const root = await repoRoot();
  const abs = resolveInside(root, path);
  const info = await stat(abs).catch(() => null);
  if (info === null) throw new Error(`仓库文件不存在：repo://${path}`);
  if (info.isDirectory()) return { text: await listDir(root, path), isDirectory: true };
  if (info.size > MAX_BYTES) throw new Error(`文件过大（${info.size} 字节）：请用 :N-M 读取片段。`);
  return { text: await readFile(abs, "utf8") };
}
