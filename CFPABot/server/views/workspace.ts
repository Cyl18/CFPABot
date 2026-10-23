import { parseLang } from "@cfpa/review-core/domain/langfile";
import type { ParsedLang } from "@cfpa/review-core/domain/langfile";
import { compareLang, inHunks } from "@cfpa/review-core/domain/diff";
import { buildLangPath, parseLangPath, langPathFor } from "@cfpa/review-core/domain/path";
import type { LangFormat, Locale } from "@cfpa/review-core/domain/path";
import type { GhFile } from "../github/client.ts";
import { prdata } from "../prdata.ts";
import { commentableHunks } from "../review.ts";
import { memoReader, sidePaths } from "./files.ts";
import type { CompareResult, CompareReview } from "@cfpa/contracts/api";

export interface WorkspaceKey {
  slug: string;
  version: string;
  namespace: string;
}

interface LangSide {
  format: LangFormat;
  base: string | null;
  head: string | null;
}

interface LangRead {
  path: string;
  text: string;
}

function pickLang(files: GhFile[], key: WorkspaceKey, locale: Locale): LangSide | null {
  const preferred = `projects/assets/${key.slug}/${key.version}/${key.namespace}/lang/${locale}.`;
  let found: GhFile | null = null;
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (!parsed) continue;
    if (parsed.slug !== key.slug || parsed.version !== key.version || parsed.namespace !== key.namespace) continue;
    if (parsed.locale !== locale) continue;
    if (file.path.startsWith(preferred)) {
      found = file;
      break;
    }
    found ??= file;
  }
  if (!found) return null;
  return { format: parseLangPath(found.path)?.format ?? "json", ...sidePaths(found) };
}

export async function compareWorkspace(n: number, key: WorkspaceKey): Promise<CompareResult> {
  const { pull, files } = await prdata.files(n);
  const missing: string[] = [];
  const readOne = memoReader();
  const readAny = async (paths: string[], ref: string, label: string): Promise<LangRead | null> => {
    for (const path of paths) {
      const text = await readOne(path, ref);
      if (text !== null) return { path, text };
    }
    missing.push(label);
    return null;
  };

  const en = pickLang(files, key, "en_us");
  const zh = pickLang(files, key, "zh_cn");
  const format = en?.format ?? zh?.format ?? "json";

  const readSide = (side: LangSide | null, locale: Locale): { base: Promise<LangRead | null>; head: Promise<LangRead | null> } => {
    const read = (path: string | null, ref: string, label: string): Promise<LangRead | null> =>
      path === null ? Promise.resolve(null) : readAny(langPathFor(path, locale), ref, label);
    if (side !== null) {
      return {
        base: read(side.base, pull.baseSha, `${locale} (base)`),
        head: read(side.head, pull.headSha, `${locale} (head)`),
      };
    }
    const guessed = langPathFor(buildLangPath(key.slug, key.version, key.namespace, locale, format), locale);
    return {
      base: readAny(guessed, pull.baseSha, `${locale} (base)`),
      head: readAny(guessed, pull.headSha, `${locale} (head)`),
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
    baseSha: pull.baseSha,
    headSha: pull.headSha,
    format,
    rows: compareLang(base, head),
    missing,
    review: compareReview(headZhText, head.zh, files),
    reviewEn: compareReview(headEnText, head.en, files),
  };
}

function compareReview(read: LangRead | null, parsed: ParsedLang | null, files: GhFile[]): CompareReview | null {
  if (read === null || parsed === null) return null;
  const file = files.find((entry) => entry.path === read.path);
  if (file === undefined || file.status === "removed") return null;
  const hunks = commentableHunks(file, read.text);
  if (hunks.length === 0) return null;
  const lines = read.text.split("\n");
  const keys: CompareReview["keys"] = {};
  for (const [key, line] of parsed.lines) {
    if (!inHunks(line, hunks)) continue;
    keys[key] = { line, raw: (lines[line - 1] ?? "").replace(/\r$/, "") };
  }
  return { path: read.path, keys };
}
