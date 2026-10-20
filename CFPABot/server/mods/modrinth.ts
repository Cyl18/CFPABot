import { z } from "zod";
import { requestJson } from "./http.ts";

const BASE = "https://api.modrinth.com/v2";

const projectSchema = z.object({
  id: z.string(),
  slug: z.string().default(""),
  title: z.string().default(""),
  icon_url: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
  project_type: z.string().default("mod"),
});

const versionFileSchema = z.object({
  url: z.string(),
  filename: z.string().default(""),
  primary: z.boolean().default(false),
  hashes: z.object({ sha1: z.string().optional() }).nullable().optional(),
});

const versionSchema = z.object({
  id: z.string(),
  project_id: z.string().default(""),
  version_number: z.string().default(""),
  date_published: z.string().default(""),
  game_versions: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  files: z.array(versionFileSchema).default([]),
});

const searchSchema = z.object({
  hits: z.array(z.object({ title: z.string().default(""), slug: z.string().default("") })).default([]),
});

export type MrProject = z.infer<typeof projectSchema>;
export type MrVersion = z.infer<typeof versionSchema>;

async function get(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await requestJson(url.toString());
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error(`Modrinth 请求失败: HTTP ${res.status} ${path}`);
  return res.body;
}

export async function getProject(slug: string): Promise<MrProject | null> {
  const body = await get(`/project/${encodeURIComponent(slug)}`);
  if (!body) return null;
  const parsed = projectSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export async function getVersions(
  slug: string,
  filter: { loaders?: string[]; gameVersions?: string[] },
): Promise<MrVersion[]> {
  const params: Record<string, string> = {};
  if (filter.loaders?.length) params.loaders = JSON.stringify(filter.loaders);
  if (filter.gameVersions?.length) params.game_versions = JSON.stringify(filter.gameVersions);
  const body = await get(`/project/${encodeURIComponent(slug)}/version`, params);
  if (!Array.isArray(body)) return [];
  return body.flatMap((item) => {
    const parsed = versionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function search(query: string, limit: number): Promise<{ title: string; slug: string; url: string }[]> {
  const body = await get("/search", {
    query,
    limit: String(limit),
    facets: JSON.stringify([["project_type:mod"]]),
  });
  const parsed = searchSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.hits.map((hit) => ({
    title: hit.title,
    slug: hit.slug,
    url: `https://modrinth.com/mod/${hit.slug}`,
  }));
}
