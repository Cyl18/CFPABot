import { mcMatches, modRefOf, parseVersionDir, standardVersionOf } from "@cfpa/review-core/domain/path";
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
  const files = mod.latestFiles.length > 0 ? mod.latestFiles : await cf.getAllFiles(mod.id);
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
  return { ...cfInfoFromMod(mod, slug), dependencies: await curseforgeDependencies(mod) };
}

function cfInfoFromMod(mod: cf.CfMod, fallbackSlug: string): Omit<ModInfo, "dependencies"> {
  const iconUrl = thumbnail(mod);
  return {
    provider: "curseforge",
    id: String(mod.id),
    slug: mod.slug || fallbackSlug,
    name: mod.name,
    url: curseforgeUrl(mod, fallbackSlug),
    ...(iconUrl ? { iconUrl } : {}),
    ...(mod.links?.sourceUrl ? { sourceUrl: mod.links.sourceUrl } : {}),
    allowDistribution: mod.allowModDistribution !== false,
    isMCreator: mod.categories.some((category) => category.id === MCREATOR_CATEGORY_ID),
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
  const version = exact.sort((a, b) => b.date_published.localeCompare(a.date_published))[0];
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
  const files = await cf.getAllFiles(modId);
  const matched = files.filter((file) => file.gameVersions.some((gv) => mcMatches(mc, gv)));
  const byLoader = matched.filter((file) => file.gameVersions.some((gv) => loaders.includes(gv.toLowerCase())));
  const candidates = (byLoader.length > 0 ? byLoader : matched).sort((a, b) => b.fileDate.localeCompare(a.fileDate));
  const file = candidates[0];
  if (file === undefined) return null;
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

  async pickCheckCfFile(raw: cf.CfMod, versionString: string, mode: "moden" | "domain" | "lang"): Promise<ModFile | null> {
    const standard = standardVersionOf(versionString);
    const fabric = versionString.endsWith("-fabric");
    const rank = (file: cf.CfFile): number =>
      fabric ? (file.gameVersions.includes("Fabric") ? 0 : 1) : file.gameVersions.includes("Fabric") ? 1 : 0;
    const select = (files: cf.CfFile[]): cf.CfFile | null => {
      const sorted = [...files];
      if (mode === "moden") sorted.sort((a, b) => b.id - a.id || rank(a) - rank(b));
      else if (mode === "domain") sorted.sort((a, b) => rank(a) - rank(b));
      return (
        sorted.find((file) =>
          (file.gameVersions.find((version) => version.includes(".")) ?? "x").startsWith(standard),
        ) ?? null
      );
    };
    const file = select(raw.latestFiles) ?? select(await cf.getAllFiles(raw.id));
    if (file === null) return null;
    return {
      provider: "curseforge",
      id: String(file.id),
      fileName: file.fileName,
      url: file.downloadUrl ?? (await cf.downloadUrl(raw.id, file.id)),
      gameVersions: file.gameVersions,
      loaders: file.gameVersions.filter((gv) => LOADER_NAMES.includes(gv.toLowerCase())).map((gv) => gv.toLowerCase()),
      date: file.fileDate,
    };
  },

  async pickCheckModrinthFile(mod: { slug: string }, versionString: string): Promise<ModFile | null> {
    const standard = standardVersionOf(versionString);
    const fabric = versionString.endsWith("-fabric");
    const versions = await mr.getVersions(mod.slug, { loaders: [fabric ? "fabric" : "forge"] });
    const version = versions.find((entry) => entry.game_versions.some((gv) => gv.startsWith(standard)));
    if (version === undefined) return null;
    const file = (fabric ? version.files.find((f) => f.filename.toLowerCase().includes("fabric")) : undefined) ?? version.files[0];
    if (file === undefined) return null;
    return {
      provider: "modrinth",
      id: file.hashes?.sha1 ?? version.id,
      fileName: file.filename,
      url: file.url,
      gameVersions: version.game_versions,
      loaders: version.loaders,
      date: version.date_published,
    };
  },

  async resolveByMapping(slug: string): Promise<{ raw: cf.CfMod; name: string; url: string; iconUrl?: string; sourceUrl?: string; allowDistribution: boolean } | null> {
    const mappedId = await mappings.get(slug);
    if (mappedId === undefined) return null;
    const raw = await cf.getMod(mappedId);
    if (raw === null) throw new Error(`找不到 CurseForge 模组 ${mappedId}`);
    const info = cfInfoFromMod(raw, slug);
    return {
      raw,
      name: info.name,
      url: info.url,
      ...(info.iconUrl ? { iconUrl: info.iconUrl } : {}),
      ...(info.sourceUrl ? { sourceUrl: info.sourceUrl } : {}),
      allowDistribution: info.allowDistribution,
    };
  },

  async cfLangDomain(raw: cf.CfMod, versionString: string): Promise<string> {
    try {
      const file = await mods.pickCheckCfFile(raw, versionString, "lang");
      if (file === null) return "未知";
      const jar = await readJar(file);
      return jar?.langDirs[0] ?? "未知";
    } catch {
      return "未知";
    }
  },

  async modrinthLangDomain(slug: string, versionString: string): Promise<string> {
    try {
      const file = await mods.pickCheckModrinthFile({ slug }, versionString);
      if (file === null) return "未知";
      const jar = await readJar(file);
      return jar?.langDirs[0] ?? "未知";
    } catch {
      return "未知";
    }
  },

  async modrinthProject(slug: string): Promise<ModInfo | null> {
    return modrinthInfo(slug);
  },

  async commentDependencies(raw: cf.CfMod): Promise<ModDep[]> {
    const newest = [...raw.latestFiles]
      .sort((a, b) => b.fileDate.localeCompare(a.fileDate))
      .find((file) => file.dependencies.length > 0);
    const ids = [
      ...new Set(
        (newest?.dependencies ?? []).filter((dep) => dep.relationType === REQUIRED_DEPENDENCY).map((dep) => dep.modId),
      ),
    ];
    if (ids.length === 0) return [];
    const found = await cf.getModsByIds(ids);
    const byId = new Map(found.map((mod) => [mod.id, mod]));
    return ids.flatMap((id) => {
      const dep = byId.get(id);
      if (dep === undefined) return [];
      const iconUrl = thumbnail(dep);
      return [
        {
          id: String(dep.id),
          slug: dep.slug,
          name: dep.name,
          url: curseforgeUrl(dep, dep.slug),
          ...(iconUrl ? { iconUrl } : {}),
          ...(dep.links?.sourceUrl ? { sourceUrl: dep.links.sourceUrl } : {}),
        },
      ];
    });
  },

  readJar(file: ModFile): Promise<JarInfo | null> {
    return readJar(file);
  },

  searchModrinth(query: string, limit: number): Promise<{ title: string; slug: string; url: string }[]> {
    return mr.search(query, limit);
  },

  mappings,
};

export function mappingMissingMessage(slug: string): string {
  return (
    `⚠ 无法找到 ${slug} 的 CurseForge 项目名到 CurseForge ID 的映射。请检查此[链接](https://www.curseforge.com/minecraft/mc-mods/${slug})是否可以正常打开，如果不能，或者网页被重定向，请修改你的文件路径。` +
    `如果可以，请联系 [Cyl18](https://github.com/Cyl18) 解决。` +
    (slug.toLowerCase() !== slug ? `此外在项目名中检测到了大写字母，请调整为小写。` : "") +
    `可以在上面的链接中右方找到 About Project -> Project ID 然后使用命令 \`/add-mapping ${slug} [CURSEFORGE_PROJECT_ID]\`. 如果路径有误则使用 \`/mv "projects/assets/${slug}/[GAME_VERSION]/" "projects/assets/[NEW_DIR]/[GAME_VERSION]/"\`.`
  );
}
