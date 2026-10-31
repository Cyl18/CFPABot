import type { Workspace } from "@cfpa/contracts/api";
import { parseLang, type ParsedLang } from "./langfile.ts";
import { langFormatFor, langPathFor, parseLangPath, type LangFormat, type LangPath, type Locale } from "./path.ts";

export interface WorkspaceFileRef {
  path: string;
  status: string;
}

export interface WorkspaceTexts {
  format: LangFormat;
  enPath: string | null;
  zhPath: string | null;
  baseEn: ParsedLang | null;
  baseZh: ParsedLang | null;
  headEn: ParsedLang | null;
  headZh: ParsedLang | null;
  baseEnText: string | null;
  baseZhText: string | null;
  headEnText: string | null;
  headZhText: string | null;
}

/** 同一 locale 有多份文件时，优先版本对应的 canonical 文件名，再按路径排序。 */
export function pickLocale(workspace: Workspace, locale: Locale): LangPath | null {
  const expected = `${locale}.${langFormatFor(workspace.version)}`;
  // 调用方可能把整个 PR 的文件列表传进来；不按 key 收窄会挑到别的 namespace 的同名文件。
  const candidates = workspace.files
    .map(parseLangPath)
    .filter(
      (entry): entry is LangPath =>
        entry !== null &&
        entry.locale === locale &&
        entry.slug === workspace.slug &&
        entry.version === workspace.version &&
        entry.namespace === workspace.namespace,
    );
  const rank = (entry: LangPath): number => {
    if (entry.fileName === expected) return 0;
    if (entry.fileName.toLowerCase() === expected) return 1;
    return entry.format === langFormatFor(workspace.version) ? 2 : 3;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))[0] ?? null;
}

export async function loadWorkspaceTexts(
  workspace: Workspace,
  files: readonly WorkspaceFileRef[],
  read: (path: string, ref: "base" | "head") => Promise<string | null>,
): Promise<WorkspaceTexts | null> {
  let enPath = pickLocale(workspace, "en_us")?.path ?? null;
  let zhPath = pickLocale(workspace, "zh_cn")?.path ?? null;
  if (enPath === null && zhPath !== null) enPath = langPathFor(zhPath, "en_us")[0] ?? null;
  if (zhPath === null && enPath !== null) zhPath = langPathFor(enPath, "zh_cn")[0] ?? null;
  if (enPath === null && zhPath === null) return null;
  const format = parseLangPath(zhPath ?? enPath ?? "")?.format ?? langFormatFor(workspace.version);

  const statusOf = new Map(files.map((file) => [file.path, file.status]));
  const readSide = async (path: string | null, locale: Locale, ref: "base" | "head"): Promise<string | null> => {
    if (path === null) return null;
    const status = statusOf.get(path);
    if (ref === "base" ? status === "added" : status === "removed") return null;
    for (const candidate of langPathFor(path, locale)) {
      const text = await read(candidate, ref);
      if (text !== null) return text;
    }
    return null;
  };
  const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([
    readSide(enPath, "en_us", "base"),
    readSide(zhPath, "zh_cn", "base"),
    readSide(enPath, "en_us", "head"),
    readSide(zhPath, "zh_cn", "head"),
  ]);
  const parse = (text: string | null, path: string | null): ParsedLang | null =>
    text === null ? null : parseLang(text, parseLangPath(path ?? "")?.format ?? format);
  return {
    format,
    enPath,
    zhPath,
    baseEn: parse(baseEnText, enPath),
    baseZh: parse(baseZhText, zhPath),
    headEn: parse(headEnText, enPath),
    headZh: parse(headZhText, zhPath),
    baseEnText,
    baseZhText,
    headEnText,
    headZhText,
  };
}
