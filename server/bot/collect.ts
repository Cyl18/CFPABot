import type { CompareRow, PrFile, Workspace } from "../../shared/api.ts";
import { compareLang } from "../domain/diff.ts";
import { parseLang, type ParsedLang } from "../domain/langfile.ts";
import { stripJsonComments } from "../domain/langfile.ts";
import { diffModPathsOf, langPathFor, parseLangPath, workspacesOf, type LangFormat, type Locale } from "../domain/path.ts";
import { glossaryTerms } from "../domain/glossary.ts";
import { matchTerms } from "../domain/terms.ts";
import { repo } from "../env.ts";
import type { GhFile, GhPull } from "../github/client.ts";
import { gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { prdata } from "../prdata.ts";
import { collapseBlankRuns, DIFF_EXCEPTION, Lines, messageOf } from "./render.ts";

export const MAX_WORKSPACES = 40;
export const MAX_CHECK_FILES = 1000;
export const MAX_DIFF_GIST = 20000;

const MAX_CONCURRENCY = 6;

const log = logger("bot/collect");

export interface PrContext {
  pull: GhPull;
  files: GhFile[];
  workspaces: Workspace[];
}

export interface WorkspaceData {
  workspace: Workspace;
  format: LangFormat;
  baseEn: ParsedLang | null;
  baseZh: ParsedLang | null;
  headEn: ParsedLang | null;
  headZh: ParsedLang | null;
  rows: CompareRow[];
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      out[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function loadPrContext(n: number): Promise<PrContext> {
  const { pull, files } = await prdata.files(n);
  return { pull, files, workspaces: workspacesOf(files) };
}

async function loadOneWorkspace(ctx: PrContext, workspace: Workspace): Promise<WorkspaceData | null> {
  let en: { path: string; format: LangFormat } | undefined;
  let zh: { path: string; format: LangFormat } | undefined;
  for (const file of workspace.files) {
    const parsed = parseLangPath(file);
    if (!parsed || parsed.locale === null) continue;
    if (parsed.locale === "en_us") en = { path: parsed.path, format: parsed.format };
    else zh = { path: parsed.path, format: parsed.format };
  }
  if (!en && zh) en = { path: langPathFor(zh.path, "en_us")[0] ?? zh.path, format: zh.format };
  if (!zh && en) zh = { path: langPathFor(en.path, "zh_cn")[0] ?? en.path, format: en.format };
  if (!en && !zh) return null;

  const statusOf = new Map(ctx.files.map((file) => [file.path, file.status]));
  const read = async (side: { path: string; format: LangFormat } | undefined, locale: Locale, ref: "base" | "head"): Promise<string | null> => {
    if (!side) return null;
    const status = statusOf.get(side.path);
    if (ref === "base" ? status === "added" : status === "removed") return null;
    for (const candidate of langPathFor(side.path, locale)) {
      const text = await gh.getFile(candidate, ref === "base" ? ctx.pull.baseSha : ctx.pull.headSha);
      if (text !== null) return text;
    }
    return null;
  };

  const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([
    read(en, "en_us", "base"),
    read(zh, "zh_cn", "base"),
    read(en, "en_us", "head"),
    read(zh, "zh_cn", "head"),
  ]);
  const baseEn = en && baseEnText !== null ? parseLang(baseEnText, en.format) : null;
  const baseZh = zh && baseZhText !== null ? parseLang(baseZhText, zh.format) : null;
  const headEn = en && headEnText !== null ? parseLang(headEnText, en.format) : null;
  const headZh = zh && headZhText !== null ? parseLang(headZhText, zh.format) : null;
  return {
    workspace,
    format: en?.format ?? zh?.format ?? "json",
    baseEn,
    baseZh,
    headEn,
    headZh,
    rows: compareLang({ en: baseEn, zh: baseZh }, { en: headEn, zh: headZh }),
  };
}

export async function loadWorkspaceData(ctx: PrContext): Promise<WorkspaceData[]> {
  const targets = ctx.workspaces.slice(0, MAX_WORKSPACES);
  if (ctx.workspaces.length > targets.length) {
    log.warn("工作区数量超过上限，仅检查前若干个", { pr: ctx.pull.number, total: ctx.workspaces.length, checked: targets.length });
  }
  const loaded = await mapLimit(targets, MAX_CONCURRENCY, (workspace) => loadOneWorkspace(ctx, workspace));
  return loaded.filter((item): item is WorkspaceData => item !== null);
}

function postProcess(value: string | null): string | null {
  if (value === null) return null;
  if (value.includes("$")) {
    return `\`${value.replaceAll("<", "\\<").replaceAll("`", "\\`").replaceAll("\n", "[换行符]")}\``;
  }
  return value
    .replaceAll("<", "\\<")
    .replaceAll("`", "\\`")
    .replaceAll("\n", "<br>")
    .replaceAll("*", "\\*")
    .replaceAll("|", "\\|");
}

function parseRefJson(text: string): Map<string, string> {
  const parsed = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ""))) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The requested operation requires an element of type 'Object'.");
  }
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("_") || out.has(key)) continue;
    out.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return out;
}

function parseRefLang(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    if (out.has(key)) continue;
    out.set(key, line.slice(eq + 1));
  }
  return out;
}

async function fetchText(path: string, ref: string): Promise<string | null> {
  try {
    return await gh.getFile(path, ref);
  } catch (err) {
    log.warn("下载语言文件失败", { path, err });
    return null;
  }
}

async function fetchLangAt(rev: string, base: string, lang: string, ext: string): Promise<string | null> {
  const first = await fetchText(`${base}/${lang}.${ext}`, rev);
  if (first !== null) return first;
  const [head, tail] = lang.split("_");
  return fetchText(`${base}/${head}_${(tail ?? "").toUpperCase()}.${ext}`, rev);
}

function isWs(value: string | null): boolean {
  return value === null || value.trim() === "";
}

type DiffRow5 = readonly [string, string | null, string | null, string | null, string | null];

function addLine(row: DiffRow5): string {
  const [, sourceEn, currentEn, sourceCn, currentCn] = row;
  let out = "";
  if (sourceEn === null || sourceEn.trim() === "") {
    out += currentEn === null || currentEn.trim() === "" ? "⛔" : currentEn;
  } else if (currentEn === null) {
    throw new Error("Object reference not set to an instance of an object.");
  } else if (sourceEn.trim() === currentEn.trim()) {
    out += currentEn;
  } else {
    out += `${sourceEn}<br>🔽<br>${currentEn}`;
  }
  out += " | ";
  if (sourceCn === null || sourceCn.trim() === "") {
    out += currentCn === null || currentCn.trim() === "" ? "⛔" : currentCn;
  } else {
    out += `${sourceCn}<br>🔽<br>${currentCn ?? ""}`;
  }
  return out;
}

interface DiffMaps {
  baseEn: Map<string, string> | null;
  baseZh: Map<string, string> | null;
  headEn: Map<string, string> | null;
  headZh: Map<string, string> | null;
}

function diffRows(maps: DiffMaps): DiffRow5[] {
  const headZh = maps.headZh;
  if (headZh === null) throw new Error("Object reference not set to an instance of an object.");
  const rows: DiffRow5[] = [];
  for (const [key, currentCn] of headZh) {
    rows.push([
      key,
      maps.baseEn?.get(key) ?? null,
      maps.headEn?.get(key) ?? null,
      maps.baseZh?.get(key) ?? null,
      currentCn,
    ]);
  }
  const processed = rows.map(([key, sourceEn, currentEn, sourceCn, currentCn]): DiffRow5 => [
    postProcess(key) as string,
    postProcess(sourceEn),
    postProcess(currentEn),
    postProcess(sourceCn),
    postProcess(currentCn),
  ]);
  const kept = processed.filter(([, , currentEn, sourceCn, currentCn]) => {
    if (sourceCn === currentCn) return false;
    return !(isWs(currentEn) && isWs(currentCn));
  });
  return [...kept.filter(([, , currentEn, , currentCn]) => currentEn !== currentCn), ...kept.filter(([, , currentEn, , currentCn]) => currentEn === currentCn)];
}

export async function buildDiffComment(pull: GhPull, files: PrFile[], publicUrl: string): Promise<string> {
  let result: string;
  try {
    const modPaths = diffModPathsOf(files.filter((file) => file.status !== "removed").map((file) => file.path));
    const sb = new Lines();
    const exceptions: string[] = [];
    const terms = await glossaryTerms();

    sb.line();
    sb.line("🔛 Diff： ");
    sb.line();

    for (const modPath of modPaths) {
      const ext = modPath.dir === "1.12.2" ? "lang" : "json";
      const base = `projects/assets/${modPath.slug}/${modPath.dir}/${modPath.domain}/lang`;
      let maps: DiffMaps;
      try {
        const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([
          fetchLangAt(pull.baseSha, base, "en_us", ext),
          fetchLangAt(pull.baseSha, base, "zh_cn", ext),
          fetchLangAt(pull.headSha, base, "en_us", ext),
          fetchLangAt(pull.headSha, base, "zh_cn", ext),
        ]);
        const parse = ext === "lang" ? parseRefLang : parseRefJson;
        maps = {
          baseEn: baseEnText === null ? null : parse(baseEnText),
          baseZh: baseZhText === null ? null : parse(baseZhText),
          headEn: headEnText === null ? null : parse(headEnText),
          headZh: headZhText === null ? null : parse(headZhText),
        };
      } catch (err) {
        log.warn("LangFileFetcher", { path: `${modPath.slug}/${modPath.dir}/${modPath.domain}`, err });
        exceptions.push(messageOf(err));
        continue;
      }
      const ordered = diffRows(maps);
      const label = `${modPath.slug}/${modPath.dir}`;

      sb.line(`<details><summary>${label}</summary>\n`);
      sb.line("| 英文 | 中文 |");
      sb.line("| --: | :------------- |");
      for (const row of ordered) {
        sb.raw("| ");
        sb.raw(addLine(row));
        sb.raw(" |\n");
      }
      sb.line("\n</details>\n\n");

      sb.line(`<details><summary>${label}-keys</summary>\n`);
      sb.line("| Key | 英文 | 中文 |");
      sb.line("| - | --: | :------------- |");
      for (const row of ordered) {
        sb.raw("| ");
        sb.raw(` \`${row[0]}\` |`);
        sb.raw(addLine(row));
        sb.raw(" |\n");
      }
      sb.line("\n</details>\n");

      sb.line(`<details><summary>${label}-术语检查</summary>\n`);
      sb.line("| Key | 英文 | 中文 | 检查结果 |");
      sb.line("| - | --: | :------------- | - |");
      for (const row of ordered) {
        const [, , currentEn, , currentCn] = row;
        if (currentEn === null || currentCn === null) continue;
        const hits = terms === null ? [] : matchTerms(terms, row[0], currentEn, currentCn, modPath.dir);
        if (hits.length === 0) continue;
        const termText = hits
          .map(
            (hit) =>
              `${hit.ok ? "✔" : "⚠"} 术语${hit.ok ? "" : "异常"} ${hit.en} => ${hit.zh.join(", ")}${hit.reason === undefined ? "" : `（${hit.reason}）`}`,
          )
          .join("\n");
        sb.raw("| ");
        sb.raw(` \`${row[0]}\` |`);
        sb.raw(addLine(row));
        sb.raw(` | ${termText.replaceAll("\n", "<br>")} |\n`);
      }
      sb.line("\n</details>\n");
    }

    if (exceptions.length > 0) {
      sb.line(`异常：\n\`\`\`\n${exceptions.join("\n\n")}\n\`\`\``);
    }
    result = collapseBlankRuns(`${sb.text()}\n`);
    if (result.length > MAX_DIFF_GIST) {
      try {
        const url = await gh.createGist(
          `pr-${pull.number}-diff`,
          `pr-${pull.number}-diff.md`,
          `PR: <https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}>\n\n${result}`,
        );
        result = `🔛 语言文件 Diff 内容过长，已经上传至 <${url}>。\n`;
      } catch (err) {
        log.error("Upload Gist", { pr: pull.number, err });
      }
    }
  } catch (err) {
    log.error(`UpdateDiffSegment ${pull.number}`, { err });
    result = `${DIFF_EXCEPTION}\n`;
  }
  if (files.some((file) => file.path.split("/").some((segment) => segment.replace(/^_+/, "").toLowerCase() === "zh_cn"))) {
    result = `\n🔛 [转到复杂文件 Diff](${publicUrl}/pr/${pull.number}/special)\n\n${result}`;
  }
  return result;
}
