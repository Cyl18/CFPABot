import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths.ts";
import type { LocalEntry, LocalFileInfo } from "./context.ts";
import { LOCAL_NAME_PATTERN } from "./sessions.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function localPath(id: string, name: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("会话 ID 非法。");
  if (!LOCAL_NAME_PATTERN.test(name)) {
    throw new Error("本地文件名无效：只能是 1-64 位字母、数字、点、下划线或连字符。");
  }
  return join(paths.sessions, id, "local", name);
}

export async function readLocal(id: string, name: string): Promise<LocalEntry | null> {
  try {
    const path = localPath(id, name);
    const info = await stat(path);
    return { content: await readFile(path, "utf8"), updatedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

export function readLocalSync(id: string, name: string): LocalEntry | null {
  try {
    const path = localPath(id, name);
    const info = statSync(path);
    return { content: readFileSync(path, "utf8"), updatedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

export async function writeLocal(id: string, name: string, content: string): Promise<LocalEntry> {
  const path = localPath(id, name);
  await mkdir(join(paths.sessions, id, "local"), { recursive: true });
  await writeFile(path, content, "utf8");
  return { content, updatedAt: new Date().toISOString() };
}

export async function listLocal(id: string): Promise<LocalFileInfo[]> {
  if (!ID_PATTERN.test(id)) throw new Error("会话 ID 非法。");
  const dir = join(paths.sessions, id, "local");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: LocalFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !LOCAL_NAME_PATTERN.test(entry.name)) continue;
    const info = await stat(join(dir, entry.name));
    files.push({ name: entry.name, size: info.size, updatedAt: info.mtime.toISOString() });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
