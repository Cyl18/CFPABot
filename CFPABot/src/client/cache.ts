// src/client/cache.ts
// Encapsulates reading and writing runtime/cache/*.json files.
// Part of the outbound adapter layer — api/ routes must not read cache files directly.
// All writes go through durable-json (writeJsonLocked) for atomicity and Windows EPERM retry.
// Consumers in flows/ and cron should use these helpers, never Bun.write directly.

import { readJsonFile, writeJsonLocked } from "../_shared/fs-utils.js";
import { MODLIST_PATH, MAPPING_PATH } from "../runtime-paths.js";



// ---- Types ----

export interface ModlistCacheEntry {
  slug: string;
  name: string;
  cfId: number;
  versions: string[];
  description: string;
}

export interface ModlistCacheFile {
  version: number;
  data: ModlistCacheEntry[];
  updatedAt: string;
}

export interface CfMappingFile {
  mapping: Record<string, number>;
  lastScannedId?: number;
  updatedAt?: string;
  batchId?: number;
}

// ---- Cache readers ----

/**
 * Read the precomputed modlist from runtime/cache/modlist.json.
 * Returns null if the file is missing or corrupt.
 */
export async function readModlistCache(): Promise<ModlistCacheFile | null> {
  return readJsonFile<ModlistCacheFile>(MODLIST_PATH);
}

/**
 * Read the curseforge slug→cfId mapping from runtime/cache/curseforge-mapping.json.
 * Returns null if the file is missing or corrupt.
 */
export async function readCurseforgeMapping(): Promise<CfMappingFile | null> {
  return readJsonFile<CfMappingFile>(MAPPING_PATH);
}

// ---- Cache writers ----

/**
 * Atomically write the modlist cache to disk.
 * Uses process-level locking (lock key "cache:modlist") so concurrent cron/api
 * writers do not tear the file.
 */
export async function writeModlistCache(file: ModlistCacheFile): Promise<void> {
  await writeJsonLocked(MODLIST_PATH, file, "cache:modlist");
}

/**
 * Atomically write the CurseForge slug→cfId mapping cache to disk.
 * Uses process-level locking (lock key "cache:curseforge-mapping") so concurrent
 * cron/api writers do not tear the file.
 */
export async function writeCurseforgeMapping(file: CfMappingFile): Promise<void> {
  await writeJsonLocked(MAPPING_PATH, file, "cache:curseforge-mapping");
}
