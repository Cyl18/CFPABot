import type { Workspace } from "../../shared/api.ts";
import { repo } from "../env.ts";
import { logger } from "../log.ts";
import { mirror } from "../mirror.ts";
import { mods } from "../mods/index.ts";
import { MODRINTH_NOTE, type ModLink, type ModsView } from "./render.ts";
import { workspaceKey } from "./collect.ts";

const MAX_MODS = 20;

const log = logger("bot/mods");

function mapErrorNote(slug: string): string {
  const lines = [
    `⚠ 无法找到 ${slug} 的 CurseForge 项目名到 CurseForge ID 的映射。请检查此[链接](https://www.curseforge.com/minecraft/mc-mods/${slug})是否可以正常打开，如果不能，或者网页被重定向，请修改你的文件路径。`,
    "如果可以，请联系 [Cyl18](https://github.com/Cyl18) 解决。",
  ];
  if (slug.toLowerCase() !== slug) lines.push("此外在项目名中检测到了大写字母，请调整为小写。");
  lines.push(
    `可以在上面的链接中右方找到 About Project -> Project ID 然后使用命令 \`/add-mapping ${slug} [CURSEFORGE_PROJECT_ID]\`. 如果路径有误则使用 \`/mv "projects/assets/${slug}/[GAME_VERSION]/" "projects/assets/[NEW_DIR]/[GAME_VERSION]/"\`.`,
  );
  return lines.join("\n");
}

async function repoLinksFor(slug: string): Promise<{ version: string; url: string }[]> {
  try {
    const list = await mirror.modList();
    const entry = list.mods.find((mod) => mod.slug === slug);
    if (!entry) return [];
    return entry.versions.map((item) => ({
      version: item.version,
      url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/projects/assets/${slug}/${item.version}`,
    }));
  } catch (err) {
    log.warn("读取模组列表失败", { slug, error: err });
    return [];
  }
}

export async function collectMods(workspaces: Workspace[]): Promise<ModsView> {
  const slugs = [...new Set(workspaces.map((workspace) => workspace.slug))];
  if (slugs.length === 0) return { kind: "empty" };
  if (slugs.length > MAX_MODS) return { kind: "tooMany" };

  const notes: string[] = [];
  const links: ModLink[] = [];
  const firstWorkspace = new Map<string, Workspace>();
  for (const workspace of workspaces) {
    if (!firstWorkspace.has(workspace.slug)) firstWorkspace.set(workspace.slug, workspace);
  }

  const curseforge = slugs.filter((slug) => slug !== "1UNKNOWN" && slug !== "0-modrinth-mod" && !slug.startsWith("modrinth-"));
  const modrinth = slugs.filter((slug) => slug.startsWith("modrinth-"));
  const unknownDomains = workspaces.filter((workspace) => workspace.slug === "0-modrinth-mod");

  for (const slug of curseforge) {
    const info = await mods.resolve(slug).catch(() => null);
    if (!info) {
      notes.push(mapErrorNote(slug));
      continue;
    }
    const workspace = firstWorkspace.get(slug);
    links.push({
      provider: "curseforge",
      name: info.name,
      url: info.url,
      iconUrl: info.iconUrl,
      sourceUrl: info.sourceUrl,
      compareWs: workspace ? workspaceKey(workspace) : undefined,
      repoLinks: await repoLinksFor(slug),
    });
    for (const dep of info.dependencies) {
      links.push({
        provider: "curseforge",
        name: dep.name,
        url: dep.url,
        iconUrl: dep.iconUrl,
        sourceUrl: info.sourceUrl,
        dependency: true,
      });
    }
  }

  for (const slug of modrinth) {
    const info = await mods.resolve(slug).catch((err: unknown) => {
      log.warn("Modrinth 检索失败", { slug, error: err });
      return null;
    });
    if (!info) {
      notes.push(`Modrinth 检索遇到问题：无法找到 ${slug}。`);
      continue;
    }
    const workspace = firstWorkspace.get(slug);
    links.push({
      provider: "modrinth",
      name: info.name,
      url: info.url,
      iconUrl: info.iconUrl,
      sourceUrl: info.sourceUrl,
      compareWs: workspace ? workspaceKey(workspace) : undefined,
      relatedText: "Modrinth",
    });
  }

  let modrinthHit = false;
  for (const namespace of [...new Set(unknownDomains.map((workspace) => workspace.namespace))]) {
    const hits = await mods.searchModrinth(namespace, 3).catch(() => []);
    if (hits.length === 0) continue;
    modrinthHit = true;
    const first = hits[0];
    if (hits.length === 1 && first) {
      notes.push(`- 找到 Modrinth 模组：[${first.title}](${first.url})`);
    } else {
      notes.push([`- ${namespace} 的 Modrinth 搜索结果：`, ...hits.map((hit) => `  - [${hit.title}](${hit.url})`)].join("\n"));
    }
  }
  if (modrinthHit) notes.push(MODRINTH_NOTE);

  if (links.length === 0) {
    if (notes.length > 0) return { kind: "list", mods: [], notes };
    return { kind: "empty" };
  }
  return { kind: "list", mods: links, notes };
}
