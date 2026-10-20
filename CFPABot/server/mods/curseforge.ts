import { join } from "node:path";
import { z } from "zod";
import { env } from "../env.ts";
import { asRecord } from "../github/mappers.ts";
import { paths } from "../paths.ts";
import { readJson, withLock, writeJson } from "../store.ts";
import { requestJson } from "./http.ts";

const BASE = "https://api.curseforge.com/v1";
const GAME_ID = 432;
const MOD_CLASS_ID = 6;
const FILE_PAGE_SIZE = 10000;
const FILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const cfFileSchema = z.object({
  id: z.number(),
  modId: z.number().default(0),
  fileName: z.string().default(""),
  fileDate: z.string().default(""),
  downloadUrl: z.string().nullable().optional(),
  gameVersions: z.array(z.string()).default([]),
  dependencies: z.array(z.object({ modId: z.number(), relationType: z.number().default(0) })).default([]),
});

export const cfModSchema = z.object({
  id: z.number(),
  gameId: z.number().default(GAME_ID),
  slug: z.string().default(""),
  name: z.string().default(""),
  links: z
    .object({ websiteUrl: z.string().nullable().optional(), sourceUrl: z.string().nullable().optional() })
    .nullable()
    .optional(),
  logo: z.object({ thumbnailUrl: z.string().nullable().optional() }).nullable().optional(),
  categories: z.array(z.object({ id: z.number(), slug: z.string().default("") })).default([]),
  latestFiles: z.array(cfFileSchema).default([]),
  allowModDistribution: z.boolean().nullable().optional(),
});

export type CfMod = z.infer<typeof cfModSchema>;
export type CfFile = z.infer<typeof cfFileSchema>;

function unwrap<T>(body: unknown, schema: z.ZodType<T>): T | null {
  const envelope = asRecord(body);
  if (!envelope) return null;
  const parsed = schema.safeParse(envelope.data);
  return parsed.success ? parsed.data : null;
}

async function cfGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const key = env.CURSEFORGE_API_KEY;
  if (!key) throw new Error("未配置 CURSEFORGE_API_KEY");
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await requestJson(url.toString(), { headers: { "x-api-key": key } });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error(`CurseForge 请求失败: HTTP ${res.status} ${path}`);
  return res.body;
}

export async function searchBySlug(slug: string): Promise<CfMod | null> {
  const body = await cfGet("/mods/search", { gameId: String(GAME_ID), classId: String(MOD_CLASS_ID), slug });
  const list = unwrap(body, z.array(cfModSchema));
  if (!list) return null;
  return list.find((mod) => mod.slug === slug) ?? null;
}

export async function getMod(id: number): Promise<CfMod | null> {
  return unwrap(await cfGet(`/mods/${id}`), cfModSchema);
}

const fileCacheSchema = z.object({ fetchedAt: z.string(), files: z.array(cfFileSchema) });

export async function getAllFiles(id: number): Promise<CfFile[]> {
  const cachePath = join(paths.cache, "cf-files", `${id}.json`);
  const cached = await readJson(cachePath, fileCacheSchema);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < FILE_CACHE_TTL_MS) return cached.files;
  return withLock(cachePath, async () => {
    const fresh = await readJson(cachePath, fileCacheSchema);
    if (fresh && Date.now() - Date.parse(fresh.fetchedAt) < FILE_CACHE_TTL_MS) return fresh.files;
    const body = await cfGet(`/mods/${id}/files`, { pageSize: String(FILE_PAGE_SIZE) });
    const files = unwrap(body, z.array(cfFileSchema)) ?? [];
    if (files.length > 0) await writeJson(cachePath, { fetchedAt: new Date().toISOString(), files });
    return files;
  });
}

export async function getModsByIds(ids: number[]): Promise<CfMod[]> {
  if (ids.length === 0) return [];
  const key = env.CURSEFORGE_API_KEY;
  if (!key) throw new Error("未配置 CURSEFORGE_API_KEY");
  const res = await requestJson(`${BASE}/mods`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ modIds: ids }),
  });
  if (res.status === 404) return [];
  if (res.status >= 400) throw new Error(`CurseForge 请求失败: HTTP ${res.status} /mods`);
  return unwrap(res.body, z.array(cfModSchema)) ?? [];
}

export async function downloadUrl(modId: number, fileId: number): Promise<string | null> {
  const body = await cfGet(`/mods/${modId}/files/${fileId}/download-url`);
  return unwrap(body, z.string());
}
