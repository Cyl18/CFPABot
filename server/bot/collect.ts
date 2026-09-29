import type { CompareRow, PrFile, Workspace } from "../../shared/api.ts";
import { compareLang } from "../domain/diff.ts";
import { parseLang, type ParsedLang } from "../domain/langfile.ts";
import { parseLangPath, langPathFor, workspacesOf, type LangFormat, type Locale } from "../domain/path.ts";
import { repo } from "../env.ts";
import type { GhFile, GhPull } from "../github/client.ts";
import { gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { prdata } from "../prdata.ts";
import { BRANCH_NOT_MAIN, type DiffRow, type DiffWorkspace, type DiffsView } from "./render.ts";

export const MAX_WORKSPACES = 40;
export const MAX_CHECK_FILES = 1000;

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
  return { pull, files, workspaces: workspacesOf(files.map((file) => file.path)) };
}

export function collectWarnings(pull: GhPull): string[] {
  const out: string[] = [];
  if (pull.baseRef !== repo.defaultBranch) out.push(BRANCH_NOT_MAIN);
  return out;
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
  if (!en && zh) en = { path: zh.path, format: zh.format };
  if (!zh && en) zh = { path: en.path, format: en.format };
  if (!en && !zh) return null;

  const read = async (side: { path: string; format: LangFormat } | undefined, locale: Locale, ref: string): Promise<string | null> => {
    if (!side) return null;
    for (const candidate of langPathFor(side.path, locale)) {
      const text = await gh.getFile(candidate, ref);
      if (text !== null) return text;
    }
    return null;
  };

  const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([
    read(en, "en_us", ctx.pull.baseSha),
    read(zh, "zh_cn", ctx.pull.baseSha),
    read(en, "en_us", ctx.pull.headSha),
    read(zh, "zh_cn", ctx.pull.headSha),
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

export function workspaceKey(workspace: { slug: string; version: string; namespace: string }): string {
  return `${workspace.slug}/${workspace.version}/${workspace.namespace}`;
}

export function collectDiffs(data: WorkspaceData[], files: PrFile[]): DiffsView {
  const workspaces: DiffWorkspace[] = [];
  for (const item of data) {
    const rows: DiffRow[] = [];
    for (const row of item.rows) {
      if (row.enStatus === "same" && row.zhStatus === "same") continue;
      rows.push({ key: row.key, baseEn: row.baseEn, headEn: row.headEn, baseZh: row.baseZh, headZh: row.headZh });
    }
    if (rows.length === 0) continue;
    const label = workspaceKey(item.workspace);
    workspaces.push({ label, ws: label, rows });
  }
  return { workspaces, specialLink: files.some((file) => isSpecialLangPath(file.path)) };
}

export function isSpecialLangPath(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => segment !== "lang" && /^_*zh_cn$/i.test(segment));
}
