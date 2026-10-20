import { join } from "node:path";
import { z } from "zod";
import type { CheckReport, Finding, ModFileCheck } from "../../shared/api.ts";
import { entryFindings, keyParity, pathChecks, typoCheck, type TypoRule } from "../domain/checks.ts";
import { glossaryTerms } from "../domain/glossary.ts";
import { matchTerms, type TermIndex } from "../domain/terms.ts";
import { patchAddedLines, withLiteralNewlines } from "../domain/diff.ts";
import { parseLang, type ParsedLang } from "../domain/langfile.ts";
import { parseLangPath } from "../domain/path.ts";
import type { JarInfo, JarLang, ModFile } from "../mods/index.ts";
import { mods } from "../mods/index.ts";
import { paths } from "../paths.ts";
import { prdata } from "../prdata.ts";
import { readJson } from "../store.ts";
import { MAX_CHECK_FILES, type PrContext, type WorkspaceData } from "./collect.ts";
import { TOO_MANY_FILES } from "./render.ts";

const typoRulesSchema = z.array(
  z.object({
    term: z.string(),
    message: z.string(),
    level: z.enum(["warn", "error"]),
    minVersion: z.string().optional(),
    skipLegacy: z.boolean().optional(),
    unless: z.array(z.string()).optional(),
  }),
);

export interface ChecksResult {
  report: CheckReport;
  extraLabels: string[];
}

interface ModTarget {
  slug: string;
  version: string;
  namespace: string;
  data: WorkspaceData;
  all: WorkspaceData[];
}

let typoRulesCache: TypoRule[] | null = null;

export async function loadTypoRules(): Promise<TypoRule[]> {
  if (typoRulesCache) return typoRulesCache;
  const parsed = await readJson(join(paths.config, "typo-rules.json"), typoRulesSchema);
  typoRulesCache = parsed ?? [];
  return typoRulesCache;
}

function relatedItems(prNumber: number, ctx: PrContext): Finding[] {
  const slugs = new Set(ctx.workspaces.map((workspace) => workspace.slug));
  const related = prdata.related(prNumber).filter((entry) => slugs.has(entry.slug));
  if (related.length === 0) return [];
  if (slugs.size > 10) {
    const numbers = [...new Set(related.map((entry) => entry.number))];
    return [
      {
        code: "related_pr",
        severity: "neutral",
        source: "program",
        detail: `有很多模组在 ${numbers.map((number) => `#${number}`).join(" ")} 中有提交`,
      },
    ];
  }
  return related.map((entry) => ({
    code: "related_pr",
    severity: "neutral" as const,
    source: "program" as const,
    detail: `${entry.slug} 在其它 PR 中有提交：#${entry.number} 中包含此模组的 ${entry.versions.join("、")} 版本`,
  }));
}

function typoItems(ctx: PrContext, rules: TypoRule[]): Finding[] {
  if (rules.length === 0) return [];
  const lines: { path: string; line: number; text: string; version: string }[] = [];
  for (const file of ctx.files) {
    const parsed = parseLangPath(file.path);
    if (!parsed || parsed.locale !== "zh_cn" || !file.patch) continue;
    for (const added of patchAddedLines(file.patch)) {
      lines.push({ path: file.path, line: added.line, text: added.text, version: parsed.version });
    }
  }
  return lines.length > 0 ? typoCheck(lines, rules) : [];
}

function entryItems(item: WorkspaceData, terms: TermIndex | null): Finding[] {
  const out: Finding[] = [];
  const unit = unitOf(item.workspace);
  for (const row of item.rows) {
    if (row.enStatus === "same" && row.zhStatus === "same") continue;
    for (const finding of entryFindings(row.key, row.headEn, row.headZh, { en: row.baseEn, zh: row.baseZh })) {
      out.push({ ...finding, unit });
    }
    if (!terms || row.headEn === undefined) continue;
    for (const hit of matchTerms(terms, row.key, row.headEn, row.headZh ?? "", item.workspace.version)) {
      if (hit.ok) continue;
      out.push({
        source: "term",
        code: `term:${hit.id ?? hit.en}`,
        severity: "major",
        detail: `${hit.en} → ${hit.zh.join(" / ")}${hit.reason ? `（${hit.reason}）` : ""}`,
        key: row.key,
        unit,
      });
    }
  }
  return out;
}

async function autoDomainItems(ctx: PrContext): Promise<Finding[]> {
  const items: Finding[] = [];
  const candidates = ctx.files.filter((file) => file.path.toLowerCase().includes("zh_cn") && file.path.split("/").length < 7).slice(0, 5);
  for (const file of candidates) {
    const names = file.path.split("/");
    const slug = names[2];
    const version = names[3];
    if (names[1] !== "assets" || slug === undefined || version === undefined || slug === "lang") continue;
    const missingDomain = names.length === 5;
    const missingLang = names.length === 6 && names[4] === "lang";
    if (!missingDomain && !missingLang) continue;
    const info = await mods.resolve(slug).catch(() => null);
    const modFile = info ? await mods.pickFile(info, version).catch(() => null) : null;
    const jar = modFile ? await mods.readJar(modFile).catch(() => null) : null;
    const domain = jar?.domains[0];
    if (!domain) {
      items.push({
        code: "bad_path_domain",
        severity: "neutral",
        source: "program",
        path: file.path,
        detail: "无法找到该模组的 Mod Domain。",
      });
      continue;
    }
    const rdir = `projects/assets/${slug}/${version}/${domain}/lang/`;
    const from = names.slice(0, missingDomain ? 4 : 5).join("/");
    items.push({
      code: "bad_path_domain",
      severity: "neutral",
      source: "program",
      path: file.path,
      detail: missingDomain
        ? `自动找到该模组 Domain 为 \`${domain}\`，可能正确文件夹为 \`${rdir}\`。使用命令 \`/mv "${from}/" "${rdir}"\` 来移动路径。`
        : `自动找到了该模组的 Mod Domain 为 \`${domain}\`，可能的正确文件夹为 \`${rdir}\`。 你可以使用命令 \`/mv "${from}/" "${rdir}"\` 来移动路径。`,
    });
  }
  return items;
}

function modTargets(data: WorkspaceData[]): ModTarget[] {
  const out: ModTarget[] = [];
  const byKey = new Map<string, ModTarget>();
  for (const item of data) {
    const { slug, version, namespace } = item.workspace;
    const key = `${slug}@${version}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.all.push(item);
      continue;
    }
    const target: ModTarget = { slug, version, namespace, data: item, all: [item] };
    byKey.set(key, target);
    out.push(target);
  }
  return out;
}

function keysOf(parsed: ParsedLang | null, skipUnderscore: boolean): Set<string> {
  if (!parsed) return new Set();
  const keys = [...parsed.entries.keys()];
  return new Set(skipUnderscore ? keys.filter((key) => !key.startsWith("_")) : keys);
}

export function sameKeySet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) {
    if (!right.has(key)) return false;
  }
  return true;
}

function compareEntries(headEn: ParsedLang, jarLang: JarLang, skipUnderscore: boolean): Pick<ModFileCheck, "missing" | "extra" | "changed"> {
  const jar = withLiteralNewlines(parseLang(jarLang.content, jarLang.format).entries);
  const pr = withLiteralNewlines(headEn.entries);
  const missing: string[] = [];
  const extra: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of jar) {
    if (skipUnderscore && key.startsWith("_")) continue;
    const mine = pr.get(key);
    if (mine === undefined) missing.push(key);
    else if (mine !== value) changed.push(key);
  }
  for (const key of pr.keys()) {
    if (skipUnderscore && key.startsWith("_")) continue;
    if (!jar.has(key)) extra.push(key);
  }
  return { missing: missing.sort(), extra: extra.sort(), changed: changed.sort() };
}

function modFileRow(item: WorkspaceData, file: ModFile, jar: JarInfo): ModFileCheck {
  const { slug, namespace, version } = item.workspace;
  const base = { slug, namespace, version, provider: file.provider, fileName: file.fileName, fetchedAt: jar.fetchedAt };
  const empty = { missing: [], extra: [], changed: [] };
  const candidates = jar.lang.filter((entry) => entry.locale === "en_us" && entry.domain === namespace);
  if (candidates.length === 0) {
    return { ...base, ...empty, status: "unavailable", note: "jar 里没有这个命名空间的英文语言文件" };
  }
  const preferred = candidates.filter((entry) => entry.format === item.format);
  if (preferred.length > 1 || (preferred.length === 0 && candidates.length > 1)) {
    return { ...base, ...empty, status: "unavailable", note: "找到了多个语言文件，跳过检查" };
  }
  if (item.headEn === null) {
    return { ...base, ...empty, status: "unavailable", note: "PR 中未找到该工作区的英文语言文件" };
  }
  const diff = compareEntries(item.headEn, preferred[0] ?? candidates[0]!, item.format === "json");
  const status = diff.missing.length > 0 || diff.changed.length > 0 ? "mismatch" : diff.extra.length > 0 ? "extra" : "ok";
  return { ...base, ...diff, status };
}

function unavailableRows(target: ModTarget, note: string): ModFileCheck[] {
  return target.all.map((item) => ({
    slug: item.workspace.slug,
    namespace: item.workspace.namespace,
    version: item.workspace.version,
    status: "unavailable" as const,
    note,
    missing: [],
    extra: [],
    changed: [],
  }));
}

function modEnItems(target: ModTarget, jar: JarInfo): Finding[] {
  const unit = unitOf(target);
  const label = `${target.namespace}-${target.version}`;
  if (!target.data.headEn) {
    return [
      {
        code: "mod_en_missing",
        severity: "major",
        source: "program",
        unit,
        detail: `获取 PR 中 ${label} 英文语言文件失败。你可能没有提交此模组的英文语言文件。使用命令 \`/update-en ${target.slug} ${target.version}\` 来获取模组语言文件。`,
      },
    ];
  }
  const files: JarLang[] = jar.lang.filter((entry) => entry.locale === "en_us" && entry.domain === target.namespace);
  if (files.length === 0) {
    return [
      {
        code: "mod_en_missing",
        severity: "neutral",
        source: "program",
        unit,
        detail: `没有找到 ${label} 模组内语言文件。`,
      },
    ];
  }
  if (files.length > 1) {
    return [
      {
        code: "mod_en_missing",
        severity: "neutral",
        source: "program",
        unit,
        detail: `找到了多个 ${label} 模组内语言文件。不进行模组语言文件检查。`,
      },
    ];
  }
  const modFile = files[0];
  if (!modFile) return [];
  const prKeys = keysOf(target.data.headEn, target.data.format === "json");
  const modKeys = keysOf(parseLang(modFile.content, modFile.format), modFile.format === "json");
  if (sameKeySet(prKeys, modKeys)) return [];
  const fileName = modFile.path.split("/").pop() ?? modFile.path;
  return [
    {
      code: "mod_en",
      severity: "major",
      source: "program",
      unit,
      detail: `PR 中 ${label} 英文文件与最新模组 \`${fileName}\` 文件不对应。自动获取只能反映多数情况，可能并不需要更新。如果你认为确实需要更新到上面的版本，使用命令 \`/update-en ${target.slug} ${target.version}\`。`,
    },
  ];
}

async function targetItems(target: ModTarget): Promise<{ findings: Finding[]; mcreator: boolean; modFiles: ModFileCheck[] }> {
  const findings: Finding[] = [];
  const unit = unitOf(target);
  if (target.slug === "1UNKNOWN" || target.slug === "0-modrinth-mod") {
    return { findings, mcreator: false, modFiles: unavailableRows(target, "未找到 Mod 下载信息") };
  }
  const info = await mods.resolve(target.slug).catch(() => null);
  if (!info) {
    findings.push({
      code: "mod_not_found",
      severity: "neutral",
      source: "program",
      unit,
      detail: `找不到模组: ${target.slug}-${target.version}。`,
    });
    return { findings, mcreator: false, modFiles: unavailableRows(target, `未找到 Mod ${target.slug} 的下载信息`) };
  }
  const expectedSlug = target.slug.startsWith("modrinth-") ? target.slug.slice("modrinth-".length) : target.slug;
  if (info.slug !== expectedSlug) {
    findings.push({
      code: "slug_changed",
      severity: "major",
      source: "program",
      unit,
      detail: `检测到此模组作者更改了 Slug 名，请使用以下命令进行路径移动：\n\`\`\`\n/mv projects/assets/${target.slug}/${target.version}/ projects/assets/${info.slug}/${target.version}/\n/add-mapping ${info.slug} ${info.id}\n\`\`\``,
    });
  }
  const file = await mods.pickFile(info, target.version).catch(() => null);
  const jar = file === null ? null : await mods.readJar(file).catch(() => null);
  if (file === null || jar === null) {
    findings.push({
      code: "mod_domain_unknown",
      severity: "neutral",
      source: "program",
      unit,
      detail:
        info.allowDistribution === false
          ? `${target.namespace} 的作者不允许此模组自动下载，Bot 无法自动获取 Mod Domain。`
          : `无法找到 \`${target.namespace}\` 的 Mod Domain。这不一定代表需要更改。`,
    });
    const note =
      file === null
        ? `未找到适用于 ${target.version} 的发布文件`
        : info.allowDistribution === false
          ? "模组作者不允许自动下载"
          : "无法下载或解析该 Mod 文件";
    return { findings, mcreator: info.isMCreator, modFiles: unavailableRows(target, note) };
  }
  if (!jar.domains.includes(target.namespace)) {
    const replacement = jar.domains.length === 1 && jar.domains[0] ? jar.domains[0] : "{MOD_DOMAIN}";
    findings.push({
      code: "mod_domain",
      severity: "major",
      source: "program",
      unit,
      detail: `Domain 验证不通过。文件 Domain 为 \`${jar.domains.join("/")}\`；而 PR 所提供的 Domain 为 \`${target.namespace}\`。`,
    });
    findings.push({
      code: "mod_domain",
      severity: "major",
      source: "program",
      unit,
      detail: `可以使用命令 \`/mv "projects/assets/${target.slug}/${target.version}/${target.namespace}/" "projects/assets/${target.slug}/${target.version}/${replacement}/"\` 来移动目录。`,
    });
  }
  findings.push(...modEnItems(target, jar));
  return { findings, mcreator: info.isMCreator, modFiles: target.all.map((item) => modFileRow(item, file, jar)) };
}

function unitOf(workspace: { slug: string; version: string }): string {
  return `${workspace.slug}/${workspace.version}`;
}

export async function collectChecks(prNumber: number, ctx: PrContext, data: WorkspaceData[]): Promise<ChecksResult> {
  const findings: Finding[] = [];
  const modFiles: ModFileCheck[] = [];
  const extraLabels: string[] = [];
  const report = (list: Finding[]): CheckReport => ({
    prNumber,
    headSha: ctx.pull.headSha,
    generatedAt: new Date().toISOString(),
    units: [...new Set(data.map((item) => unitOf(item.workspace)))],
    findings: list,
    modFiles,
  });
  if (ctx.files.length > MAX_CHECK_FILES) {
    return {
      report: report([{ code: "too_many_files", severity: "major", source: "program", detail: TOO_MANY_FILES }]),
      extraLabels,
    };
  }

  findings.push(...pathChecks(ctx.files));
  findings.push(...(await autoDomainItems(ctx)));
  findings.push(...relatedItems(prNumber, ctx));
  findings.push(...typoItems(ctx, await loadTypoRules()));
  const terms = await glossaryTerms().catch(() => null);

  for (const item of data) {
    const unit = unitOf(item.workspace);
    findings.push(...keyParity(unit, item.headEn, item.headZh));
    findings.push(...entryItems(item, terms));
  }

  for (const target of modTargets(data)) {
    const result = await targetItems(target);
    findings.push(...result.findings);
    modFiles.push(...result.modFiles);
    if (result.mcreator && !extraLabels.includes("MCreator")) extraLabels.push("MCreator");
  }

  return { report: report(findings), extraLabels };
}
