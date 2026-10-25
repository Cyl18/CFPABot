import pMap from "p-map";
import type { CompareRow, PrFile, Workspace } from "@cfpa/contracts/api";
import { compareLang } from "@cfpa/review-core/domain/diff";
import { parseLang, type ParsedLang } from "@cfpa/review-core/domain/langfile";
import { diffModPathsOf, workspacesOf, type LangFormat } from "@cfpa/review-core/domain/path";
import { loadWorkspaceTexts } from "@cfpa/review-core/domain/workspace-files";
import { MAX_WORKSPACES } from "@cfpa/review-core/pack";
import { glossaryTerms } from "../domain/glossary.ts";
import { matchTerms } from "@cfpa/review-core/domain/terms";
import { repo } from "../env.ts";
import type { GhFile, GhPull } from "../github/client.ts";
import { botWritesEnabled, gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { prdata } from "../prdata.ts";
import { collapseBlankRuns, DIFF_EXCEPTION, Lines, messageOf } from "./render.ts";

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

export async function loadPrContext(n: number): Promise<PrContext> {
  const { pull, files } = await prdata.files(n);
  return { pull, files, workspaces: workspacesOf(files) };
}

async function loadOneWorkspace(ctx: PrContext, workspace: Workspace): Promise<WorkspaceData | null> {
  const loaded = await loadWorkspaceTexts(workspace, ctx.files, (path, ref) =>
    gh.getFile(path, ref === "base" ? ctx.pull.baseSha : ctx.pull.headSha),
  );
  if (loaded === null) return null;
  return {
    workspace,
    format: loaded.format,
    baseEn: loaded.baseEn,
    baseZh: loaded.baseZh,
    headEn: loaded.headEn,
    headZh: loaded.headZh,
    rows: compareLang({ en: loaded.baseEn, zh: loaded.baseZh }, { en: loaded.headEn, zh: loaded.headZh }),
  };
}

export async function loadWorkspaceData(ctx: PrContext): Promise<WorkspaceData[]> {
  const targets = ctx.workspaces.slice(0, MAX_WORKSPACES);
  if (ctx.workspaces.length > targets.length) {
    log.warn("工作区数量超过上限，仅检查前若干个", { pr: ctx.pull.number, total: ctx.workspaces.length, checked: targets.length });
  }
  const loaded = await pMap(targets, (workspace) => loadOneWorkspace(ctx, workspace), { concurrency: MAX_CONCURRENCY });
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

function parseRef(text: string, format: LangFormat): Map<string, string> {
  const parsed = parseLang(text, format);
  if (format === "json" && parsed.errors.length > 0) throw new Error(parsed.errors[0] ?? "JSON 语法错误");
  const out = new Map<string, string>();
  for (const [key, value] of parsed.entries) {
    if (key.startsWith("_")) continue;
    out.set(key, value);
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
        const format: LangFormat = ext === "lang" ? "lang" : "json";
        maps = {
          baseEn: baseEnText === null ? null : parseRef(baseEnText, format),
          baseZh: baseZhText === null ? null : parseRef(baseZhText, format),
          headEn: headEnText === null ? null : parseRef(headEnText, format),
          headZh: headZhText === null ? null : parseRef(headZhText, format),
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
    if (result.length > MAX_DIFF_GIST && botWritesEnabled()) {
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
