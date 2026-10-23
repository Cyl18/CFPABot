import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths } from "../paths.ts";
import type { LocalEntry, LocalFileInfo } from "./context.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 会话 workspace 的相对路径：允许子目录，不允许空段、`.`、`..`、反斜杠与绝对路径。 */
export function isLocalPath(path: string): boolean {
  if (path.length === 0 || path.length > 400) return false;
  return path.split("/").every((segment) => SEGMENT.test(segment));
}

export function localDir(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("会话 ID 非法。");
  return join(paths.sessions, id, "local");
}

function localPath(id: string, name: string): string {
  if (!isLocalPath(name)) {
    throw new Error("本地路径无效：只能是字母、数字、点、下划线或连字符组成的相对路径，不能含 .. 或绝对路径。");
  }
  return join(localDir(id), name);
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

export async function writeLocal(id: string, name: string, content: string): Promise<LocalEntry> {
  const path = localPath(id, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  if (process.platform === "linux") {
    // bash 以 nobody 跑，workspace 必须让它可写。
    await chmod(dirname(path), 0o777).catch(() => undefined);
    await chmod(path, 0o666).catch(() => undefined);
  }
  return { content, updatedAt: new Date().toISOString() };
}

export async function listLocal(id: string): Promise<LocalFileInfo[]> {
  const root = localDir(id);
  if (!existsSync(root)) return [];
  const files: LocalFileInfo[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), name);
      else if (entry.isFile()) {
        const info = await stat(join(dir, entry.name));
        files.push({ name, size: info.size, updatedAt: info.mtime.toISOString() });
      }
    }
  };
  await walk(root, "");
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
