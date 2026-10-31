import { parseLang } from "@cfpa/review-core/domain/langfile";
import type { ParsedLang } from "@cfpa/review-core/domain/langfile";
import { compareLang, inHunks } from "@cfpa/review-core/domain/diff";
import { buildLangPath, langPathFor } from "@cfpa/review-core/domain/path";
import type { LangFormat, Locale } from "@cfpa/review-core/domain/path";
import type { GhFile } from "../github/client.ts";
import { prdata } from "../prdata.ts";
import { commentableHunks } from "../review.ts";
import { sidePaths, type FileSide, type FileSource } from "../domain/pr.ts";
import type { CompareResult, CompareReview, Workspace } from "@cfpa/contracts/api";
import { pickLocale } from "@cfpa/review-core/domain/workspace-files";

export interface WorkspaceKey {
  slug: string;
  version: string;
  namespace: string;
}

interface LangSide {
  path: string;
  format: LangFormat;
  base: string | null;
  head: string | null;
}

interface LangRead {
  path: string;
  text: string;
}

function pickLang(files: GhFile[], key: WorkspaceKey, locale: Locale): LangSide | null {
  const workspace: Workspace = { ...key, files: files.map((file) => file.path) };
  const picked = pickLocale(workspace, locale);
  if (picked === null) return null;
  const file = files.find((entry) => entry.path === picked.path);
  if (file === undefined) return null;
  return { path: picked.path, format: picked.format, ...sidePaths(file) };
}

export async function compareWorkspace(
  n: number,
  key: WorkspaceKey,
  source: FileSource,
  reviewKeys?: number,
): Promise<CompareResult> {
  const { files } = await prdata.files(n);
  const [baseSha, headSha] = await Promise.all([source.ref("base"), source.ref("head")]);
  const missing: string[] = [];
  const readOne = source.read;
  const readAny = async (paths: string[], side: FileSide, label: string): Promise<LangRead | null> => {
    for (const path of paths) {
      const text = await readOne(path, side);
      if (text !== null) return { path, text };
    }
    missing.push(label);
    return null;
  };

  const en = pickLang(files, key, "en_us");
  const zh = pickLang(files, key, "zh_cn");
  const format = en?.format ?? zh?.format ?? "json";

  const candidates = (path: string, locale: Locale): string[] => {
    const variants = langPathFor(path, locale);
    return variants[0] === path ? variants : [path, ...variants];
  };
  const readSide = (side: LangSide | null, locale: Locale): { base: Promise<LangRead | null>; head: Promise<LangRead | null> } => {
    if (side !== null) {
      return {
        base: side.base === null ? Promise.resolve(null) : readAny(candidates(side.base, locale), "base", `${locale} (base)`),
        head: side.head === null ? Promise.resolve(null) : readAny(candidates(side.head, locale), "head", `${locale} (head)`),
      };
    }
    const guessed = candidates(buildLangPath(key.slug, key.version, key.namespace, locale, format), locale);
    return {
      base: readAny(guessed, "base", `${locale} (base)`),
      head: readAny(guessed, "head", `${locale} (head)`),
    };
  };

  const enText = readSide(en, "en_us");
  const zhText = readSide(zh, "zh_cn");
  const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([enText.base, zhText.base, enText.head, zhText.head]);

  const base = {
    en: baseEnText === null ? null : parseLang(baseEnText.text, en?.format ?? format),
    zh: baseZhText === null ? null : parseLang(baseZhText.text, zh?.format ?? format),
  };
  const head = {
    en: headEnText === null ? null : parseLang(headEnText.text, en?.format ?? format),
    zh: headZhText === null ? null : parseLang(headZhText.text, zh?.format ?? format),
  };

  return {
    workspace: { slug: key.slug, version: key.version, namespace: key.namespace },
    baseSha,
    headSha,
    format,
    rows: compareLang(base, head),
    missing,
    review: compareReview(headZhText, head.zh, files, zh?.path ?? null, reviewKeys),
    reviewEn: compareReview(headEnText, head.en, files, en?.path ?? null, reviewKeys),
  };
}

function compareReview(
  read: LangRead | null,
  parsed: ParsedLang | null,
  files: GhFile[],
  pickedPath: string | null,
  maxKeys?: number,
): CompareReview | null {
  const path = read?.path ?? pickedPath;
  const file =
    files.find((entry) => entry.path === path) ??
    (pickedPath === null ? undefined : files.find((entry) => entry.path === pickedPath));
  if (file === undefined) return null;
  if (file.status === "removed") return { path: file.path, keys: {}, unavailable: "removed" };
  if (read === null || parsed === null) return null;
  const hunks = commentableHunks(file, read.text);
  if (hunks === null) return { path: read.path, keys: {}, unavailable: "no_patch" };
  if (hunks.length === 0) return null;
  const lines = read.text.split("\n");
  const keys: CompareReview["keys"] = {};
  let kept = 0;
  let omitted = 0;
  for (const [key, line] of parsed.lines) {
    if (!inHunks(line, hunks)) continue;
    if (maxKeys !== undefined && kept >= maxKeys) {
      omitted += 1;
      continue;
    }
    keys[key] = { line, raw: (lines[line - 1] ?? "").replace(/\r$/, "") };
    kept += 1;
  }
  return { path: read.path, keys, ...(omitted === 0 ? {} : { keysOmitted: omitted }) };
}
