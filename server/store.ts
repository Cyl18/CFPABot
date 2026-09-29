import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export async function readJson<T>(path: string, schema?: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!schema) return raw as T;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function writeJson(path: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        await rm(tmp, { force: true });
        throw err;
      }
      await Bun.sleep(40 * (attempt + 1));
    }
  }
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

export function isNotFound(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}
