import type { PrFile } from "../../shared/api.ts";
import { modInfosOf } from "../domain/path.ts";
import { repo } from "../env.ts";
import { logger } from "../log.ts";
import { mirror } from "../mirror.ts";
import { mappingMissingMessage, mods } from "../mods/index.ts";
import type { CfMod } from "../mods/curseforge.ts";
import { Lines, messageOf, MODRINTH_NOTE, NO_MODS, TOO_MANY_MODS, urlEncodeDotNet } from "./render.ts";

const MAX_MODS = 20;

const log = logger("bot/mods");

interface CfAddon {
  raw: CfMod;
  name: string;
  url: string;
  iconUrl?: string;
  sourceUrl?: string;
}

function thumbnailCell(iconUrl: string | undefined): string {
  return iconUrl === undefined ? "✨" : `<image src="${iconUrl}" width="32"/>`;
}

async function repoLinkCell(slug: string): Promise<string> {
  const parts = ["<details> <summary>语言文件链接</summary>"];
  try {
    for (const version of await mirror.modVersions(slug)) {
      const label = version.version === "1.12.2" ? "1.12" : version.version;
      for (const domain of version.namespaces) {
        parts.push(
          `[${label}](https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/projects/assets/${slug}/${version.version}/${domain}/lang/) <br/>`,
        );
      }
    }
  } catch (err) {
    parts.push(`❌ ${messageOf(err)}`);
    log.error("GetModRepoLinkText", { slug, err });
  }
  parts.push("</details>");
  return parts.join("");
}

export async function collectMods(files: PrFile[], prNumber: number, publicUrl: string): Promise<string> {
  const sb = new Lines();
  const table = new Lines();
  try {
    const modInfos = modInfosOf(files.map((file) => file.path));
    const modids = [...new Set(modInfos.map((info) => info.slug))];
    if (modids.length > MAX_MODS) {
      sb.line(TOO_MANY_MODS);
      return sb.text();
    }

    const addons: CfAddon[] = [];
    for (const slug of modids) {
      if (slug === "1UNKNOWN" || slug === "0-modrinth-mod" || slug.startsWith("modrinth-")) continue;
      const resolved = await mods.resolveByMapping(slug);
      if (resolved === null) {
        sb.line(mappingMissingMessage(slug));
        continue;
      }
      addons.push(resolved);
    }

    const modrinthList: { name: string; url: string; iconUrl?: string }[] = [];
    const modrinthErrors = new Lines();
    for (const slug of modids) {
      if (!slug.startsWith("modrinth-")) continue;
      const project = await mods.modrinthProject(slug.slice("modrinth-".length));
      if (project === null) {
        modrinthErrors.line(`Modrinth 检索遇到问题：找不到 Modrinth 项目 ${slug.slice("modrinth-".length)}`);
        continue;
      }
      modrinthList.push(project);
    }
    if (modrinthErrors.text().trim() !== "") {
      sb.line();
      sb.raw(modrinthErrors.text());
      sb.line();
    }

    const modDomains = [...new Set(modInfos.filter((info) => info.slug === "0-modrinth-mod").map((info) => info.domain))];
    let flag1 = false;
    for (const namespace of modDomains) {
      const project = await mods.modrinthProject(namespace);
      if (project !== null) {
        sb.line(`- 找到 Modrinth 模组：[${project.name}](${project.url})`);
        flag1 = true;
        continue;
      }
      try {
        const hits = await mods.searchModrinth(namespace, 3);
        sb.line();
        sb.line(`- ${namespace} 的 Modrinth 搜索结果：`);
        for (const hit of hits) sb.line(`  - [${hit.title}](${hit.url})`);
        sb.line();
        flag1 = true;
      } catch (err) {
        log.warn("Modrinth 搜索失败", { namespace, err });
      }
    }
    if (flag1) {
      sb.line();
      sb.line(MODRINTH_NOTE);
      sb.line();
      sb.line("---");
      sb.line();
    }

    if (addons.length === 0 && modrinthList.length === 0) {
      sb.line(NO_MODS);
      return sb.text();
    }

    table.line("|     | 模组 | 🔗 链接 | :art: 相关文件 |");
    table.line("| --- | --- | --- | --- |");
    let modCount = 0;

    for (const project of modrinthList) {
      const name = project.name.trim().replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("|", "\\|");
      table.line(
        `| <image src="${project.iconUrl ?? ""}" width="32"/> | [**${name}**](${project.url}) |  [🟩 MCMOD](https://cn.bing.com/search?q=site:mcmod.cn%20${urlEncodeDotNet(project.name)}) \\| [:file_folder: 对比(Azusa)](${publicUrl}/pr/${prNumber}/compare) | Modrinth |`,
      );
      modCount++;
    }

    for (const addon of addons) {
      const name = addon.name.trim().replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("|", "\\|");
      const source = addon.sourceUrl ? `[:mag: 源代码](${addon.sourceUrl})&nbsp;&nbsp;` : ":mag:无源代码";
      table.line(
        `| ${thumbnailCell(addon.iconUrl)} | [**${name}**](${addon.url}) | ${source} \\| [🟩 MCMOD](https://cn.bing.com/search?q=site:mcmod.cn%20${urlEncodeDotNet(addon.name)}) \\| [:file_folder: 对比(Azusa)](${publicUrl}/pr/${prNumber}/compare) | ${await repoLinkCell(addon.raw.slug)} |`,
      );
      modCount++;
      const deps = await mods.commentDependencies(addon.raw).catch((err: unknown) => {
        log.error("获取依赖失败", { slug: addon.raw.slug, err });
        return [];
      });
      for (const dep of deps) {
        const depName = dep.name.replaceAll("[", "\\[").replaceAll("]", "\\]");
        table.line(
          `|  ${thumbnailCell(dep.iconUrl)} | 依赖-[*${depName}*](${dep.url}) | ${source} \\| [🟩 MCMOD](https://cn.bing.com/search?q=site:mcmod.cn%20${urlEncodeDotNet(dep.name)}) \\| &nbsp;&nbsp;* | * |`,
        );
        modCount++;
      }
    }

    if (modCount > 8) {
      sb.line(`<details> <summary>模组列表</summary> \n\n${table.text()}\n\n</details>`);
    } else {
      sb.line(table.text());
    }
    return sb.text();
  } catch (err) {
    log.error("更新 mod 列表出错", { error: err });
    sb.line(table.text());
    sb.line();
    sb.line(`⚠ 更新模组列表出错: ${messageOf(err)}`);
    return sb.text();
  }
}
