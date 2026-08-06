// src/client/local-repo.ts
// Encapsulates local filesystem access to a cloned MMLP repo (projects/assets/).
// Part of the outbound adapter layer — all direct node:fs access from api/ routes
// must go through this module.

import { stat, readFile, readdir } from "node:fs/promises";
import { unzip } from "unzipit";
import { join, resolve, normalize } from "node:path";
import { buildRawUrl } from "./github/helpers.js";

// ---- Path resolution ----

export function getRepoPath(): string {
  // Use import.meta.dir (Bun: file dirname) over process.cwd() for stability
  const projectRoot = import.meta.dir
    ? join(import.meta.dir, "..", "..")
    : process.cwd();
  return process.env.LOCAL_REPO_PATH ?? join(projectRoot, "..", "minecraft", "Minecraft-Mod-Language-Package");
}

export async function repoExists(): Promise<boolean> {
  try {
    await stat(getRepoPath());
    return true;
  } catch {
    return false;
  }
}

// ---- File-level reads ----

/**
 * Read a file relative to the local repo root.
 * Returns null if the repo path is unavailable, the file does not exist,
 * or the relative path escapes the repo root (`..` 路径遍历防护)。
 */
export async function readRepoFile(relativePath: string): Promise<string | null> {
  const localPath = getRepoPath();
  try {
    await stat(localPath);
  } catch {
    return null;
  }
  const fullPath = resolve(join(localPath, relativePath));
  // 路径遍历防护:normalize 后的绝对路径必须位于仓库根目录内(参考 pi-transcript-reader.safeTranscriptAbs)
  const rootPrefix = normalize(resolve(localPath)).replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  if (!normalize(fullPath).replace(/\\/g, "/").startsWith(rootPrefix)) return null;
  try {
    return await readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}

// ---- Mod asset enumeration ----
export async function readModSlugs(): Promise<string[]> {
  const assetsDir = join(getRepoPath(), "projects", "assets");
  try {
    await stat(assetsDir);
  } catch {
    return [];
  }
  try {
    return await readdir(assetsDir);
  } catch {
    return [];
  }
}

/**
 * List version directories for a mod slug.
 * Returns [] if the slug directory doesn't exist.
 */
export async function readModVersions(slug: string): Promise<string[]> {
  const slugDir = join(getRepoPath(), "projects", "assets", slug);
  try {
    return await readdir(slugDir);
  } catch {
    return [];
  }
}

// ---- Lang file probing ----

export interface LangFileInfo {
  /** Relative path from repo root, e.g. projects/assets/modid/1.16.5/domain/lang/en_us.json */
  path: string;
  type: "en" | "zh";
  /** Raw.githubusercontent.com URL for the file on the default branch */
  url: string;
}

/**
 * Enumerate language files for a mod from the local clone.
 * Deduplicates by version+type, preferring the first occurrence.
 * When `options.gameVersion` is set, only that version directory is scanned.
 * Returns [] when the local clone is unavailable.
 */
export async function probeModLangFiles(
  modId: string,
  modDomain: string,
  config: { owner: string; repoName: string },
  options?: { gameVersion?: string },
): Promise<LangFileInfo[]> {
  const assetsDir = join(getRepoPath(), "projects", "assets", modId);
  try {
    await stat(assetsDir);
  } catch {
    return [];
  }

  const results: LangFileInfo[] = [];
  const seen = new Set<string>();

  let versionDirs: string[];
  try {
    versionDirs = await readdir(assetsDir);
  } catch {
    return [];
  }

  for (const version of versionDirs) {
    if (options?.gameVersion && version !== options.gameVersion) continue;

    const langDir = join(assetsDir, version, modDomain, "lang");
    let files: string[];
    try {
      files = await readdir(langDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".json") && !file.endsWith(".lang")) continue;

      const isZh = file.toLowerCase().startsWith("zh_");
      const type = isZh ? "zh" : "en" as const;
      const key = `${version}|${type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const relPath = `projects/assets/${modId}/${version}/${modDomain}/lang/${file}`;
      const url = buildRawUrl(config.owner, config.repoName, relPath, "main");
      results.push({ path: relPath, type, url });
    }
  }

  return results;
}

// ---- ZIP extraction ----

/**
 * Extract a single file entry from a ZIP/JAR buffer.
 */
export async function extractZipEntry(
  zipBuffer: Uint8Array,
  entryPath: string,
): Promise<string> {
  const { entries } = await unzip(zipBuffer);
  const normalizedPath = entryPath.replace(/\\/g, "/");

  let entry = entries[normalizedPath];
  if (!entry) {
    const lowerPath = normalizedPath.toLowerCase();
    entry = Object.values(entries).find(
      (e) => e.name.toLowerCase() === lowerPath,
    );
  }

  if (!entry) {
    const lowerPath = normalizedPath.toLowerCase();
    entry = Object.values(entries).find(
      (e) =>
        e.name.endsWith("/" + normalizedPath) ||
        e.name.toLowerCase().endsWith("/" + lowerPath),
    );
  }

  if (!entry) {
    const available = Object.keys(entries).slice(0, 20).join(", ");
    throw new Error(
      `Entry "${normalizedPath}" not found in ZIP. Available entries: ${available}`,
    );
  }

  return entry.text();
}

/**
 * List file entries in a ZIP/JAR buffer that match a given pattern.
 */
export async function listZipEntries(
  zipBuffer: Uint8Array,
  pattern?: RegExp,
): Promise<Array<{ name: string; size: number; compressedSize: number }>> {
  const { entries } = await unzip(zipBuffer);
  const all = Object.values(entries).map((e) => ({
    name: e.name,
    size: e.size,
    compressedSize: e.compressedSize,
  }));
  if (pattern) {
    return all.filter((e) => pattern.test(e.name));
  }
  return all;
}
