import { mcMatches, modRefOf, parseVersionDir } from "../domain/path.ts";
import { env } from "../env.ts";
import { logger } from "../log.ts";
import { ttlCache } from "../ttl.ts";
import * as cf from "./curseforge.ts";
import { readJar } from "./jar.ts";
import { mappings } from "./mappings.ts";
import * as mr from "./modrinth.ts";
import type { JarInfo, ModDep, ModFile, ModInfo } from "./types.ts";

export type { JarInfo, JarLang, ModDep, ModFile, ModInfo } from "./types.ts";

const log = logger("mods");
const RESOLVE_TTL_MS = 30 * 60 * 1000;
const MCREATOR_CATEGORY_ID = 4906;
const REQUIRED_DEPENDENCY = 3;
const LOADER_NAMES = ["forge", "fabric", "neoforge", "quilt"];

const resolveCache = ttlCache<ModInfo | null>(RESOLVE_TTL_MS, 300);

function curseforgeUrl(mod: cf.CfMod, fallbackSlug: string): string {
  return mod.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${mod.slug || fallbackSlug}`;
}

function thumbnail(mod: cf.CfMod): string | undefined {
  return mod.logo?.thumbnailUrl ?? undefined;
}

async function curseforgeDependencies(mod: cf.CfMod): Promise<ModDep[]> {
  const files = mod.latestFiles.length > 0 ? mod.latestFiles : await cf.getFiles(mod.id);
  const newest = [...files].sort((a, b) => b.fileDate.localeCompare(a.fileDate)).find((f) => f.dependencies.length > 0);
  const requiredIds = [
    ...new Set((newest?.dependencies ?? []).filter((d) => d.relationType === REQUIRED_DEPENDENCY).map((d) => d.modId)),
  ];
  if (requiredIds.length === 0) return [];
  let found: cf.CfMod[];
  try {
    found = await cf.getModsByIds(requiredIds);
  } catch (err) {
    log.warn("获取 CurseForge 依赖失败", { mod: mod.slug, err });
    return [];
  }
  return found.map((dep) => {
    const iconUrl = thumbnail(dep);
    return {
      id: String(dep.id),
      slug: dep.slug,
      name: dep.name,
      url: curseforgeUrl(dep, dep.slug),
      ...(iconUrl ? { iconUrl } : {}),
    };
  });
}

async function curseforgeInfo(slug: string): Promise<ModInfo | null> {
  if (!env.CURSEFORGE_API_KEY) return null;
  const mappedId = await mappings.get(slug);
  let mod = mappedId === undefined ? null : await cf.getMod(mappedId);
  mod ??= await cf.searchBySlug(slug);
  if (!mod) return null;
  const iconUrl = thumbnail(mod);
  return {
    provider: "curseforge",
    id: String(mod.id),
    slug: mod.slug || slug,
    name: mod.name,
    url: curseforgeUrl(mod, slug),
    ...(iconUrl ? { iconUrl } : {}),
    ...(mod.links?.sourceUrl ? { sourceUrl: mod.links.sourceUrl } : {}),
    allowDistribution: mod.allowModDistribution !== false,
    isMCreator: mod.categories.some((category) => category.id === MCREATOR_CATEGORY_ID),
    dependencies: await curseforgeDependencies(mod),
  };
}

async function modrinthInfo(slug: string): Promise<ModInfo | null> {
  const project = await mr.getProject(slug);
  if (!project) return null;
  const realSlug = project.slug || slug;
  return {
    provider: "modrinth",
    id: project.id,
    slug: realSlug,
    name: project.title,
    url: `https://modrinth.com/mod/${realSlug}`,
    ...(project.icon_url ? { iconUrl: project.icon_url } : {}),
    ...(project.source_url ? { sourceUrl: project.source_url } : {}),
    allowDistribution: true,
    isMCreator: false,
    dependencies: [],
  };
}

async function pickModrinthFile(mod: ModInfo, mc: string, loaders: string[]): Promise<ModFile | null> {
  let versions = await mr.getVersions(mod.slug, { loaders, gameVersions: [mc] });
  if (versions.length === 0) versions = await mr.getVersions(mod.slug, { loaders });
  if (versions.length === 0) versions = await mr.getVersions(mod.slug, {});
  const exact = versions.filter((version) => version.game_versions.some((gv) => mcMatches(mc, gv)));
  const version = exact[0] ?? versions[0];
  if (!version) return null;
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) return null;
  return {
    provider: "modrinth",
    id: file.hashes?.sha1 || version.id,
    fileName: file.filename,
    url: file.url,
    gameVersions: version.game_versions,
    loaders: version.loaders,
    date: version.date_published,
  };
}

async function pickCurseforgeFile(mod: ModInfo, mc: string, loaders: string[]): Promise<ModFile | null> {
  const modId = Number(mod.id);
  if (!Number.isInteger(modId)) return null;
  let files = await cf.getFiles(modId, mc);
  if (files.length === 0) files = await cf.getFiles(modId);
  const matched = files.filter((file) => file.gameVersions.some((gv) => mcMatches(mc, gv)));
  const pool = matched.length > 0 ? matched : files;
  const byLoader = pool.filter((file) => file.gameVersions.some((gv) => loaders.includes(gv.toLowerCase())));
  const candidates = (byLoader.length > 0 ? byLoader : pool).sort((a, b) => b.fileDate.localeCompare(a.fileDate));
  const file = candidates[0];
  if (!file) return null;
  return {
    provider: "curseforge",
    id: String(file.id),
    fileName: file.fileName,
    url: file.downloadUrl ?? (await cf.downloadUrl(modId, file.id)),
    gameVersions: file.gameVersions,
    loaders: file.gameVersions.filter((gv) => LOADER_NAMES.includes(gv.toLowerCase())).map((gv) => gv.toLowerCase()),
    date: file.fileDate,
  };
}

export const mods = {
  async resolve(slug: string): Promise<ModInfo | null> {
    const ref = modRefOf(slug);
    if (ref.provider === "none") return null;
    return resolveCache.wrap(`${ref.provider}:${ref.slug}`, () =>
      ref.provider === "modrinth" ? modrinthInfo(ref.slug) : curseforgeInfo(ref.slug),
    );
  },

  invalidate(slug: string): void {
    const ref = modRefOf(slug);
    resolveCache.delete(`${ref.provider}:${ref.slug}`);
  },

  async pickFile(mod: ModInfo, versionDir: string): Promise<ModFile | null> {
    const parsed = parseVersionDir(versionDir);
    if (!parsed) return null;
    const loaders = parsed.loader === "fabric" ? ["fabric", "quilt"] : ["forge", "neoforge"];
    return mod.provider === "modrinth"
      ? pickModrinthFile(mod, parsed.mc, loaders)
      : pickCurseforgeFile(mod, parsed.mc, loaders);
  },

  readJar(file: ModFile): Promise<JarInfo | null> {
    return readJar(file);
  },

  searchModrinth(query: string, limit: number): Promise<{ title: string; slug: string; url: string }[]> {
    return mr.search(query, limit);
  },

  mappings,
};
