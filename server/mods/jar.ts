import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { paths } from "../paths.ts";
import { logger } from "../log.ts";
import { downloadBytes } from "./http.ts";
import type { JarInfo, JarLang, ModFile } from "./types.ts";
import type { Locale } from "../domain/path.ts";

const log = logger("mods");
const MAX_JAR_BYTES = 200 * 1024 * 1024;
const LANG_ENTRY = /^assets\/([^/]+)\/lang\/([^/]+)$/i;
const LOCALE_BY_FILE: Record<string, Locale> = { "en_us.json": "en_us", "en_us.lang": "en_us", "zh_cn.json": "zh_cn", "zh_cn.lang": "zh_cn" };

async function jarBytes(file: ModFile): Promise<{ bytes: Uint8Array; fetchedAt: string } | null> {
  if (!file.url) return null;
  const cachePath = join(paths.jars, `${file.provider}-${file.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.jar`);
  const cached = await stat(cachePath).catch(() => null);
  if (cached && cached.size > 0 && cached.size <= MAX_JAR_BYTES) {
    return { bytes: new Uint8Array(await readFile(cachePath)), fetchedAt: new Date(cached.mtimeMs).toISOString() };
  }
  const bytes = await downloadBytes(file.url, MAX_JAR_BYTES);
  if (!bytes) return null;
  await mkdir(paths.jars, { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, cachePath);
  return { bytes, fetchedAt: new Date().toISOString() };
}

export async function readJar(file: ModFile): Promise<JarInfo | null> {
  const cached = await jarBytes(file);
  if (!cached) return null;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(cached.bytes);
  } catch (err) {
    log.warn("无法解析 Mod 压缩包", { file: file.fileName, err });
    return null;
  }
  const decoder = new TextDecoder("utf-8");
  const domains = new Set<string>();
  const lang: JarLang[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/") || !name.startsWith("assets/")) continue;
    const match = LANG_ENTRY.exec(name);
    const domain = match?.[1] ?? name.split("/")[1];
    if (!domain) continue;
    if (domain !== "minecraft") domains.add(domain);
    const fileName = match?.[2]?.toLowerCase();
    const locale = fileName ? LOCALE_BY_FILE[fileName] : undefined;
    if (!match || !locale) continue;
    lang.push({
      path: name,
      domain,
      locale,
      format: fileName?.endsWith(".lang") ? "lang" : "json",
      content: decoder.decode(data),
    });
  }
  return { file, fetchedAt: cached.fetchedAt, domains: [...domains].sort(), lang };
}
