import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripJsonComments, stripTrailingCommas } from "../domain/langfile.ts";
import { commentVersionDir, compareMc, diffModPathOf, invalidVersionError } from "../domain/path.ts";
import { gh } from "../github/client.ts";
import { logger } from "../log.ts";
import type { CfMod } from "../mods/curseforge.ts";
import { mods } from "../mods/index.ts";
import type { ModInfo } from "../mods/types.ts";
import { checkReportPath } from "../paths.ts";
import { prdata } from "../prdata.ts";
import { loadTypoRules } from "./checks.ts";
import { MAX_CHECK_FILES, type PrContext } from "./collect.ts";
import { CHECK_TRANSLATE_HINT, Lines, messageOf, TOO_MANY_FILES } from "./render.ts";

const log = logger("bot/check-comment");
const MAX_BAD_PATH_FILES = 5;
const MAX_MOD_SLUGS_FOR_DETAIL = 10;
const MAX_REPORT_EMBED = 30000;

function genericBadPath(path: string): string {
  return `⚠ 检测到一个语言文件，但提交路径不正常。请检查提交路径：\`${path}\``;
}

function appendRelated(sb: Lines, ctx: PrContext): void {
  const modSlugs: string[] = [];
  const seen = new Set<string>();
  for (const file of ctx.files) {
    if (!file.path.startsWith("projects") || file.path.split("/").length < 7) continue;
    try {
      const parsed = diffModPathOf(file.path);
      if (parsed !== null && !seen.has(parsed.slug)) {
        seen.add(parsed.slug);
        modSlugs.push(parsed.slug);
      }
    } catch (err) {
      log.info("关系检查路径解析失败", { path: file.path, err });
    }
  }
  const related = prdata.related(ctx.pull.number, modSlugs);
  let relFlag = false;
  if (modSlugs.length > MAX_MOD_SLUGS_FOR_DETAIL) {
    if (modSlugs.some((slug) => prdata.hasRelation(slug))) {
      relFlag = true;
      sb.raw("ℹ 有很多模组在 ");
      const numbers = new Set<number>();
      for (const entry of related) {
        if (numbers.has(entry.number)) continue;
        numbers.add(entry.number);
        sb.raw(`#${entry.number} `);
      }
      sb.raw("中有提交");
    }
  } else {
    for (const slug of modSlugs) {
      const entries = related.filter((entry) => entry.slug === slug);
      if (entries.length === 0) continue;
      relFlag = true;
      sb.line(`ℹ ${slug} 在其它 PR 中有提交：`);
      for (const entry of entries) {
        const versions = entry.versions.map((version) => (version === "1.12.2" ? "1.12" : version)).join(", ");
        sb.line(`  - #${entry.number} 中包含此模组的 ${versions} 版本`);
      }
      sb.line();
    }
  }
  if (relFlag) {
    sb.line();
    sb.line("---");
    sb.line();
  }
}

async function appendAutoDomain(sb: Lines, names: string[], take: number): Promise<void> {
  const slug = names[2] as string;
  const versionString = names[3] as string;
  const from = names.slice(0, take).join("/");
  try {
    if (commentVersionDir(versionString) === null) throw invalidVersionError(versionString);
    if (take === 4 && slug.startsWith("modrinth-")) {
      const real = slug.slice("modrinth-".length);
      const project = await mods.modrinthProject(real);
      if (project === null) throw new Error(`找不到 Modrinth 项目 ${real}`);
      const domain = await mods.modrinthLangDomain(real, versionString);
      const rdir = `projects/assets/${slug}/${versionString}/${domain}/lang/`;
      sb.line(`  自动找到该模组 Domain 为 \`${domain}\`，可能正确文件夹为 \`${rdir}\`。使用命令 \`/mv "${from}/" "${rdir}"\` 来移动路径。`);
      sb.line();
      return;
    }
    const addon = await mods.resolveByMapping(slug);
    if (addon === null) throw new Error(`找不到 CurseForge 模组 ${slug}`);
    const domain = await mods.cfLangDomain(addon.raw, versionString);
    const rdir = `projects/assets/${slug}/${versionString}/${domain}/lang/`;
    if (take === 5) {
      sb.line(`  自动找到了该模组的 Mod Domain 为 \`${domain}\`，可能的正确文件夹为 \`${rdir}\`。 你可以使用命令 \`/mv "${from}/" "${rdir}"\` 来移动路径。`);
    } else {
      sb.line(`  自动找到该模组 Domain 为 \`${domain}\`，可能正确文件夹为 \`${rdir}\`。使用命令 \`/mv "${from}/" "${rdir}"\` 来移动路径。`);
    }
    sb.line();
  } catch (err) {
    log.warn("自动寻找 Domain 失败", { path: names.join("/"), err });
    sb.line("  无法找到该模组的 Mod Domain。");
    sb.line();
  }
}

async function appendBadPaths(sb: Lines, ctx: PrContext): Promise<void> {
  const candidates = ctx.files
    .filter((file) => file.path.toLowerCase().includes("zh_cn") && file.path.split("/").length < 7)
    .slice(0, MAX_BAD_PATH_FILES);
  for (const file of candidates) {
    const names = file.path.split("/");
    if (names.length === 1) {
      sb.line(genericBadPath(file.path));
      continue;
    }
    if (names.length < 5 && (file.path.includes(".lang") || file.path.includes(".json"))) {
      sb.line(genericBadPath(file.path));
      continue;
    }
    if (names[0] !== "projects") continue;
    try {
      if (names.length === 5) {
        if (names[1] !== "assets" || names[2] === "lang") {
          sb.line(genericBadPath(file.path));
          sb.line();
          continue;
        }
        sb.line(`⚠ 检测到一个语言文件，但是提交路径不正常。缺少了 {ModDomain} 和 lang 文件夹。请检查你的提交路径：\`${file.path}\`；`);
        await appendAutoDomain(sb, names, 4);
      }
      if (names.length === 6) {
        if (names[1] !== "assets" || names[2] === "lang") {
          sb.line(genericBadPath(file.path));
          sb.line();
          continue;
        }
        if (names[4] === "lang") {
          sb.line(`⚠ 检测到一个语言文件，但提交路径不正常。缺少了 {ModDomain} 或 {CurseForge 项目名} 文件夹。请检查提交路径：\`${file.path}\`；`);
          await appendAutoDomain(sb, names, 5);
        } else {
          sb.line(`⚠ 检测到一个语言文件，但提交路径不正常。缺少了 lang 文件夹。请检查提交路径：\`${file.path}\`；`);
          sb.line();
        }
      }
    } catch (err) {
      log.warn("Report invalid dir", { path: file.path, err });
      sb.line(genericBadPath(file.path));
      sb.line();
    }
  }
}

interface JsonKeys {
  keys: string[] | null;
  syntaxError: string | null;
}

function jsonKeys(text: string, allowTrailingCommas: boolean): JsonKeys {
  const cleaned = text.replace(/^\uFEFF/, "");
  const body = allowTrailingCommas
    ? stripTrailingCommas(stripJsonComments(cleaned))
    : stripJsonComments(cleaned);
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { keys: null, syntaxError: null };
    return { keys: Object.keys(parsed), syntaxError: null };
  } catch (err) {
    return { keys: null, syntaxError: messageOf(err) };
  }
}

function langKeySet(text: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    keys.add(line.split("=")[0] as string);
  }
  return keys;
}

function lineIndexOf(text: string, key: string): number {
  return text.split("\n").findIndex((line) => line.includes(key)) + 1;
}

function keySet(keys: string[]): Set<string> {
  return new Set(keys.filter((key) => !key.startsWith("_")));
}

function reportKeyLines(heading: string, keys: readonly string[]): string {
  return `${heading}: \n${keys.map((key) => `    ${key}\n`).join("")}`;
}

function analyzeCoreKey(
  modid: string,
  version: string,
  enKeys: Set<string>,
  cnKeys: Set<string>,
  sb: Lines,
  reportSb: Lines,
  enfile: string,
  cnfile: string,
): boolean {
  reportSb.line(`${modid}-${version} 中文语言文件共有 ${cnKeys.size} 个 Key； 英文语言文件共有 ${enKeys.size} 个 Key`);
  const enExcept = [...enKeys].filter((key) => !cnKeys.has(key));
  const cnExcept = [...cnKeys].filter((key) => !enKeys.has(key));
  if (enExcept.length === 0 && cnExcept.length === 0) {
    sb.line(`ℹ ${modid}-${version} 中英文 Key 相互对应。`);
    return false;
  }
  sb.line(`⚠ PR 中 ${modid}-${version} 中英文 Key 不对应。`);
  sb.raw("\n<details><summary>详细报告</summary>\n\n");
  if (enExcept.length > 0) {
    const examples = enExcept
      .slice(0, 3)
      .map((key) => `  - 行 ${lineIndexOf(enfile, key)}-\`${key}\``)
      .join("\n");
    sb.line(`- 英文有 ${enExcept.length} 个 Key 多于中文。例如：\n${examples}`);
    reportSb.line(reportKeyLines("英文多于中文的 Key", enExcept));
  }
  if (cnExcept.length > 0) {
    const examples = cnExcept
      .slice(0, 3)
      .map((key) => `  - 行 ${lineIndexOf(cnfile, key)}-\`${key}\``)
      .join("\n");
    sb.line(`- 中文有 ${cnExcept.length} 个 Key 多于英文。例如：\n${examples}`);
    reportSb.line(reportKeyLines("中文多于英文的 Key", cnExcept));
  }
  sb.raw("\n\n</details>\n");
  reportSb.line();
  sb.line();
  return true;
}

function analyzeKeyJson(
  modid: string,
  version: string,
  enfile: string,
  cnfile: string,
  sb: Lines,
  reportSb: Lines,
): boolean {
  const en = jsonKeys(enfile, false);
  if (en.syntaxError !== null) {
    sb.line(`❌ ${modid}-${version} 的语言文件中有 JSON 语法错误：${en.syntaxError}`);
    reportSb.line(en.syntaxError);
    return true;
  }
  const cn = jsonKeys(cnfile, false);
  if (cn.syntaxError !== null) {
    sb.line(`❌ ${modid}-${version} 的语言文件中有 JSON 语法错误：${cn.syntaxError}`);
    reportSb.line(cn.syntaxError);
    return true;
  }
  if (en.keys === null || cn.keys === null) {
    sb.line(`ℹ ${modid}-${version} 语言文件检查失败：顶层不是 JSON 对象`);
    reportSb.line("语言文件检查失败： 顶层不是 JSON 对象");
    return false;
  }
  if (en.keys.length === 0) {
    sb.line(`ℹ ${modid}-${version} 英文文件为空。`);
    return true;
  }
  if (cn.keys.length === 0) {
    sb.line(`ℹ ${modid}-${version} 中文文件为空。`);
    return true;
  }
  return analyzeCoreKey(modid, version, keySet(en.keys), keySet(cn.keys), sb, reportSb, enfile, cnfile);
}

function analyzeKeyLang(
  modid: string,
  version: string,
  enfile: string,
  cnfile: string,
  sb: Lines,
  reportSb: Lines,
): boolean {
  if (enfile.trim() === "") {
    sb.line(`ℹ ${modid}-${version} 英文文件为空。`);
    return false;
  }
  if (cnfile.trim() === "") {
    sb.line(`ℹ ${modid}-${version} 中文文件为空。`);
    return false;
  }
  return analyzeCoreKey(modid, version, langKeySet(enfile), langKeySet(cnfile), sb, reportSb, enfile, cnfile);
}

function analyzeKey(
  modid: string,
  version: string,
  enfile: string,
  cnfile: string,
  sb: Lines,
  reportSb: Lines,
): boolean {
  return version === "1.12.2"
    ? analyzeKeyLang(modid, version, enfile, cnfile, sb, reportSb)
    : analyzeKeyJson(modid, version, enfile, cnfile, sb, reportSb);
}

function analyzeCoreModEn(
  modid: string,
  version: string,
  curseID: string,
  downloadModName: string,
  enKeys: Set<string>,
  modKeys: Set<string>,
  sb: Lines,
  reportSb: Lines,
  enfile: string,
  modfile: string,
): boolean {
  reportSb.line(`${modid}-${version} 模组内语言文件共有 ${modKeys.size} 个 Key；`);
  const enExcept = [...enKeys].filter((key) => !modKeys.has(key));
  const modExcept = [...modKeys].filter((key) => !enKeys.has(key));
  if (enExcept.length === 0 && modExcept.length === 0) {
    sb.line(`ℹ ${modid}-${version} 模组内语言文件与 PR 相同。`);
    return false;
  }
  sb.line(
    `⚠ PR 中 ${modid}-${version} 英文文件与最新模组 \`${downloadModName}\` 文件不对应。自动获取只能反映多数情况，**可能并不需要更新**。如果你认为**确实**需要更新到**上面的版本**，使用命令 \`/update-en ${curseID} ${version}\`。`,
  );
  sb.raw("\n<details><summary>详细报告</summary>\n\n");
  if (enExcept.length > 0) {
    const examples = enExcept
      .slice(0, 2)
      .map((key) => `  - 行 ${lineIndexOf(enfile, key)}-\`${key}\``)
      .join("\n");
    sb.line(`- 英文有 ${enExcept.length} 个 Key 多于模组内。例如：\n${examples}`);
    reportSb.line(reportKeyLines("英文多于模组内的 Key", enExcept));
  }
  if (modExcept.length > 0) {
    const examples = modExcept
      .slice(0, 2)
      .map((key) => `  - 行 ${lineIndexOf(modfile, key)}-\`${key}\``)
      .join("\n");
    sb.line(`- 模组内有 ${modExcept.length} 个 Key 多于英文。例如：\n${examples}`);
    reportSb.line(reportKeyLines("模组内多于英文的 Key", modExcept));
  }
  sb.raw("\n\n</details>\n");
  reportSb.line();
  sb.line();
  return true;
}

function analyzeModEnJson(
  modid: string,
  version: string,
  curseID: string,
  downloadModName: string,
  enfile: string,
  modfile: string,
  sb: Lines,
  reportSb: Lines,
): boolean {
  const en = jsonKeys(enfile, true);
  if (en.syntaxError !== null) {
    sb.line(`❌ ${modid}-${version} 语言文件 JSON 语法错误：${en.syntaxError}`);
    reportSb.line(en.syntaxError);
    return true;
  }
  const mod = jsonKeys(modfile, true);
  if (mod.syntaxError !== null) {
    sb.line(`❌ ${modid}-${version} 语言文件 JSON 语法错误：${mod.syntaxError}`);
    reportSb.line(mod.syntaxError);
    return true;
  }
  if (en.keys === null || mod.keys === null) {
    sb.line(`ℹ ${modid}-${version} 语言文件检查失败：顶层不是 JSON 对象`);
    reportSb.line("语言文件检查失败： 顶层不是 JSON 对象");
    return false;
  }
  if (en.keys.length === 0 || mod.keys.length === 0) return true;
  return analyzeCoreModEn(
    modid,
    version,
    curseID,
    downloadModName,
    keySet(en.keys),
    keySet(mod.keys),
    sb,
    reportSb,
    enfile,
    modfile,
  );
}

function analyzeModEnLang(
  modid: string,
  version: string,
  curseID: string,
  downloadModName: string,
  enfile: string,
  modfile: string,
  sb: Lines,
  reportSb: Lines,
): boolean {
  if (enfile.trim() === "" || modfile.trim() === "") return false;
  return analyzeCoreModEn(
    modid,
    version,
    curseID,
    downloadModName,
    langKeySet(enfile),
    langKeySet(modfile),
    sb,
    reportSb,
    enfile,
    modfile,
  );
}

function analyzeModEn(
  modid: string,
  version: string,
  curseID: string,
  downloadModName: string,
  enfile: string,
  modfile: string,
  sb: Lines,
  reportSb: Lines,
): boolean {
  return version === "1.12.2"
    ? analyzeModEnLang(modid, version, curseID, downloadModName, enfile, modfile, sb, reportSb)
    : analyzeModEnJson(modid, version, curseID, downloadModName, enfile, modfile, sb, reportSb);
}

async function fetchText(path: string, ref: string): Promise<string | null> {
  try {
    return await gh.getFile(path, ref);
  } catch (err) {
    log.warn("下载语言文件失败", { path, err });
    return null;
  }
}

async function checkDomainIds(raw: CfMod, versionString: string): Promise<string[] | null> {
  try {
    const file = await mods.pickCheckCfFile(raw, versionString, "domain");
    if (file === null) return null;
    const jar = await mods.readJar(file);
    return jar === null ? null : jar.assetDirs;
  } catch (err) {
    log.warn("Mod Domain 检查失败", { mod: raw.slug, err });
    return null;
  }
}

async function modrinthDomainIds(mod: ModInfo, versionString: string): Promise<string[] | null> {
  try {
    const file = await mods.pickCheckModrinthFile(mod, versionString);
    if (file === null) return null;
    const jar = await mods.readJar(file);
    return jar === null ? null : jar.assetDirs;
  } catch (err) {
    log.warn("Modrinth Domain 检查失败", { mod: mod.slug, err });
    return null;
  }
}

function looseEnCandidate(path: string, name: string): boolean {
  const lower = name.toLowerCase();
  const isEn = lower === "en_us.json" || lower === "en_us.lang";
  const isZh = lower === "zh_cn.json" || lower === "zh_cn.lang";
  const guarded =
    path.includes("lang") && path.includes("assets") && path.split("/").every((segment) => segment !== "minecraft");
  return guarded ? isEn : isZh;
}

async function modEnFiles(raw: CfMod, versionString: string): Promise<{ files: string[] | null; fileName: string | null }> {
  try {
    const file = await mods.pickCheckCfFile(raw, versionString, "moden");
    if (file === null) return { files: null, fileName: null };
    const jar = await mods.readJar(file);
    if (jar === null) return { files: null, fileName: null };
    let candidates = jar.langLoose.filter((entry) => looseEnCandidate(entry.path, entry.name));
    const hasJson = candidates.some((entry) => entry.name.endsWith(".json"));
    const hasLang = candidates.some((entry) => entry.name.endsWith(".lang"));
    if (candidates.length === 2 && hasJson && hasLang) {
      const wanted = versionString === "1.12.2" ? ".lang" : ".json";
      candidates = candidates.filter((entry) => entry.name.endsWith(wanted));
    }
    return { files: candidates.map((entry) => entry.content), fileName: file.fileName };
  } catch (err) {
    log.warn("获取模组语言文件失败", { mod: raw.slug, err });
    return { files: null, fileName: null };
  }
}

async function appendUnit(
  sb: Lines,
  reportSb: Lines,
  ctx: PrContext,
  curseID: string,
  versionString: string,
  modid: string,
): Promise<boolean> {
  let addon: { raw: CfMod; allowDistribution: boolean } | null = null;
  if (curseID !== "1UNKNOWN" && curseID !== "0-modrinth-mod" && !curseID.startsWith("modrinth-")) {
    try {
      addon = await mods.resolveByMapping(curseID);
    } catch (err) {
      log.warn("获取模组失败", { curseID, err });
      addon = null;
    }
    if (addon === null) sb.line(`⚠ 找不到模组: ${curseID}-${versionString}。`);
  }

  if (addon !== null && addon.raw.slug !== curseID) {
    sb.line("❌ 检测到此模组作者更改了 Slug 名，请使用以下命令进行路径移动：");
    sb.line("```");
    sb.line(`/mv projects/assets/${curseID}/${versionString}/ projects/assets/${addon.raw.slug}/${versionString}/`);
    sb.line(`/add-mapping ${addon.raw.slug} ${addon.raw.id}`);
    sb.line("```");
    sb.line();
  }

  if (addon !== null) {
    try {
      const filemodid = await checkDomainIds(addon.raw, versionString);
      if (filemodid === null || filemodid.length === 0) {
        sb.line(
          addon.allowDistribution === false
            ? `ℹ ${modid} 的作者不允许此模组自动下载，Bot 无法自动获取 Mod Domain。`
            : `ℹ 无法找到 \`${modid}\` 的 Mod Domain。这不一定代表需要更改。`,
        );
      }
      if (filemodid !== null) {
        if (filemodid.includes(modid)) {
          sb.line(`✔ \`${modid}\` Mod Domain 验证通过。`);
        } else {
          const replacement = filemodid.length !== 1 ? "{MOD_DOMAIN}" : (filemodid[0] ?? "");
          sb.line(`❗ Domain 验证不通过。文件 Domain 为 \`${filemodid.join("/")}\`；而 PR 所提供的 Domain 为 \`${modid}\`。`);
          sb.line(`可以使用命令 \`/mv "projects/assets/${curseID}/${versionString}/${modid}/" "projects/assets/${curseID}/${versionString}/${replacement}/"\` 来移动目录。`);
        }
      }
    } catch (err) {
      sb.line(`⚠ Domain 验证失败：${messageOf(err)}`);
    }
  }

  if (curseID.startsWith("modrinth-")) {
    let project: ModInfo | null = null;
    try {
      project = await mods.modrinthProject(curseID.slice("modrinth-".length));
    } catch (err) {
      log.warn("获取 Modrinth 项目失败", { curseID, err });
    }
    if (project === null) {
      sb.line(`⚠ 找不到模组: ${curseID}-${versionString}。`);
    } else {
      try {
        const filemodid = await modrinthDomainIds(project, versionString);
        if (filemodid === null || filemodid.length === 0) {
          sb.line(`ℹ 无法找到 \`modrinth~${modid}\` 的 Mod Domain。这不一定代表需要更改。`);
        }
        if (filemodid === null) {
          throw new Error("Object reference not set to an instance of an object.");
        }
        if (filemodid.includes(modid)) {
          sb.line(`✔ \`${modid}\` Mod Domain 验证通过。`);
        } else {
          const replacement = filemodid.length !== 1 ? "{MOD_DOMAIN}" : (filemodid[0] ?? "");
          sb.line(`❗ Domain 验证不通过。文件 Domain 为 \`${filemodid.join("/")}\`；而 PR 所提供的 Domain 为 \`${modid}\`。`);
          sb.line(`可以使用命令 \`/mv "projects/assets/${curseID}/${versionString}/${modid}/" "projects/assets/${curseID}/${versionString}/${replacement}/"\` 来移动目录。`);
        }
      } catch (err) {
        sb.line(`⚠ Domain 验证失败：${messageOf(err)}`);
      }
    }
  }

  reportSb.line(`开始检查 ${modid} ${versionString}`);

  const langDir = `projects/assets/${curseID}/${versionString}/${modid}/lang`;
  const cnName = versionString === "1.12.2" ? "zh_cn.lang" : "zh_cn.json";
  const enName = versionString === "1.12.2" ? "en_us.lang" : "en_us.json";
  let cnfile = await fetchText(`${langDir}/${cnName}`, ctx.pull.headSha);
  if (cnfile === null) cnfile = await fetchText(`${langDir}/${cnName.replaceAll("zh_cn", "zh_CN")}`, ctx.pull.headSha);
  if (cnfile === null) {
    sb.line(`⚠ 获取 PR 中 ${modid}-${versionString} 中文语言文件失败。如果你在提交/更新英文语言文件，请忽略。`);
  }
  let enfile = await fetchText(`${langDir}/${enName}`, ctx.pull.headSha);
  if (enfile === null) enfile = await fetchText(`${langDir}/${enName.replaceAll("en_us", "en_US")}`, ctx.pull.headSha);
  if (enfile === null) {
    sb.line(
      `❌ 获取 PR 中 ${modid}-${versionString} 英文语言文件失败。你可能没有提交此模组的英文语言文件。使用命令 \`/update-en ${curseID} ${versionString}\` 来获取模组语言文件。`,
    );
  }

  let modENFile: string[] | null = null;
  let downloadModName: string | null = null;
  if (addon !== null && curseID !== "1UNKNOWN") {
    const fetched = await modEnFiles(addon.raw, versionString);
    modENFile = fetched.files;
    downloadModName = fetched.fileName;
  }

  let keyResult = false;
  if (cnfile !== null && enfile !== null) {
    keyResult = analyzeKey(modid, versionString, enfile, cnfile, sb, reportSb);
  }

  let modKeyResult = false;
  if (modENFile !== null && enfile !== null) {
    if (modENFile.length === 0) {
      sb.line(`ℹ 没有找到 ${modid}-${versionString} 模组内语言文件。`);
    } else if (modENFile.length > 1) {
      sb.line(`ℹ 找到了多个 ${modid}-${versionString} 模组内语言文件。不进行模组语言文件检查。`);
    } else if (addon !== null) {
      modKeyResult = analyzeModEn(
        modid,
        versionString,
        curseID,
        downloadModName ?? "",
        enfile,
        modENFile[0] as string,
        sb,
        reportSb,
      );
    }
  }

  sb.line();
  return keyResult || modKeyResult;
}

async function appendUnits(sb: Lines, reportSb: Lines, ctx: PrContext): Promise<boolean> {
  let reportedKey = false;
  const checked = new Set<string>();
  for (const file of ctx.files) {
    const names = file.path.split("/");
    if (names.length < 7 || names[0] !== "projects" || names[5] !== "lang") continue;
    const curseID = names[2] as string;
    const versionString = names[3] as string;
    const modid = names[4] as string;
    if (commentVersionDir(versionString) === null) throw invalidVersionError(versionString);
    const checkKey = `${versionString}\u0000${curseID}`;
    if (checked.has(checkKey)) continue;
    checked.add(checkKey);
    if (await appendUnit(sb, reportSb, ctx, curseID, versionString, modid)) reportedKey = true;
  }
  return reportedKey;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function patchKeptLines(patch: string): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (HUNK_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") || line.startsWith(" ")) out.push(line.slice(1));
  }
  return out;
}

function shortenLine(line: string, checkname: string, version: string): string {
  const index = version === "1.12.2" ? line.indexOf("=") : line.indexOf(":");
  if (index === -1) return line;
  let value = line.slice(index + 1);
  if (value.length > 28) {
    const nameIndex = value.indexOf(checkname);
    const from = Math.max(0, nameIndex - 12);
    const to = Math.min(value.length, nameIndex + checkname.length + 12);
    if (from === 0 && to === value.length) return line;
    value = `${from !== 0 ? "..." : ""}${value.slice(from, to)}${from !== value.length ? "..." : ""}`;
  }
  return value;
}

async function appendTypos(sb: Lines, reportSb: Lines, ctx: PrContext): Promise<boolean> {
  const rules = await loadTypoRules();
  let typoResult = false;
  const reported = new Set<string>();
  for (const file of ctx.files) {
    const names = file.path.split("/");
    if (names.length < 7 || names[0] !== "projects") continue;
    if (!(names[6] as string).includes("zh")) continue;
    if (file.patch === undefined) continue;
    const versionString = names[3] as string;
    for (const text of patchKeptLines(file.patch)) {
      if (commentVersionDir(versionString) === null) throw invalidVersionError(versionString);
      for (const rule of rules) {
        if (!text.includes(rule.term)) continue;
        if (rule.unless?.some((token) => text.includes(token))) continue;
        if (rule.minVersion !== undefined && compareMc(versionString, rule.minVersion) < 0) continue;
        if (rule.skipLegacy === true && versionString === "1.12.2") continue;
        if (!reported.has(rule.term)) {
          reported.add(rule.term);
          typoResult = true;
          const example = shortenLine(text.replaceAll("`", "\\`"), rule.term, versionString);
          const prefix = rule.level === "error" ? "❌ 可能错误译名" : "ℹ 可能争议译名";
          sb.line(`${prefix}：\`${rule.term}\`，${rule.message}。例如 \`${example}\`。`);
        }
        // 祖母侧 DiffPatch 的 NewIndex 恒为 0，勿改为真实行号
        reportSb.line(`检测到${rule.level === "error" ? "错误" : "争议"}译名：${rule.term} ${file.path}-0: ${text}`);
      }
    }
  }
  return typoResult;
}

function appendReport(
  sb: Lines,
  reportText: string,
  reportUrl: string,
  typoResult: boolean,
): void {
  if (reportText.length > MAX_REPORT_EMBED) {
    sb.line();
    if (typoResult) sb.line(CHECK_TRANSLATE_HINT);
    sb.line(`更多报告在 [这里](${reportUrl}) 查看。 PR 更新也会更新检查。`);
    return;
  }
  sb.raw("\n<details> <summary>详细检查报告</summary> \n");
  sb.raw(reportText.replaceAll("\n", "<br>").replaceAll(" ", "&nbsp;"));
  sb.raw("</details>\n\n");
  if (typoResult) sb.line(CHECK_TRANSLATE_HINT);
  sb.line(`报告在 [这里](${reportUrl}) 查看。PR 更新也会更新检查。`);
}

export async function buildCheckComment(ctx: PrContext, publicUrl: string): Promise<string> {
  const sb = new Lines();
  const reportSb = new Lines();
  try {
    if (ctx.files.length > MAX_CHECK_FILES) {
      sb.line(TOO_MANY_FILES);
      return sb.text();
    }
    appendRelated(sb, ctx);

    if (ctx.files.some((file) => file.path.split("/").includes("patchouli_book"))) {
      sb.line("⚠ 检测到了一个名为 patchouli_book 的文件夹。你可能想说的是 patchouli_books？");
    }

    const illegal = ctx.files.find(
      (file) => file.path.includes("lang") && [...file.path].some((ch) => !/[0-9A-Za-z_\-./]/.test(ch)),
    );
    if (illegal !== undefined) {
      sb.line("⚠⚠⚠ **检测到了可能不合规的路径。**");
      sb.line("⚠⚠⚠ **检测到了可能不合规的路径。**");
      sb.line("⚠⚠⚠ **检测到了可能不合规的路径。**");
      sb.line(`⚠⚠⚠ 例如： \`${illegal.path}\``);
      sb.line(`⚠⚠⚠ 转到 <a href="${publicUrl}/api/Utils/PathValidation?pr=${ctx.pull.number}" rel="nofollow">这里</a> 来查看所有不合规的路径。`);
      sb.line();
    }

    await appendBadPaths(sb, ctx);

    let reportedCap = false;
    for (const file of ctx.files) {
      const names = file.path.split("/");
      if (names.length < 7 || names[0] !== "projects" || names[5] !== "lang") continue;
      if (!names.some((segment) => segment !== "1UNKNOWN" && segment.toLowerCase() !== segment)) continue;
      reportSb.line(`检测到大写字母：${file.path}`);
      if (!reportedCap) {
        sb.line(`⚠ 警告：文件路径中含有大写字母。如 \`${file.path}\`。`);
        reportedCap = true;
      }
    }

    const reportedKey = await appendUnits(sb, reportSb, ctx);
    const typoResult = await appendTypos(sb, reportSb, ctx);

    if (reportedCap || reportedKey || typoResult) {
      const reportText = reportSb.text();
      const reportPath = checkReportPath(ctx.pull.number, ctx.pull.headSha);
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, reportText, "utf8");
      const reportUrl = `${publicUrl}/api/Utils/Report/${ctx.pull.number}/${ctx.pull.headSha.slice(0, 7)}`;
      appendReport(sb, reportText, reportUrl, typoResult);
    }
  } catch (err) {
    log.error("检查出错", { pr: ctx.pull.number, error: err });
    sb.line(`⚠ 检查出错: ${messageOf(err)}`);
  }
  return sb.text();
}
