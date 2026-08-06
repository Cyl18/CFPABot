// src/flows/_internal/collect-language-pairs.ts
// Cross-domain internal: collect base/head language file pairs for every
// changed mod path in a PR diff. Preserves the original path form (assets vs
// old layout) when deriving sibling locale paths. Per-file errors don't
// discard usable pairs.
// No Flow definition — called by translation_analyze, pr_compare, and
// info-comment translation-diff collector.

import type { FlowContext } from "../../types.js";
import type {
  LanguageFilePair,
  LanguagePairError,
  ParsedLangFile,
  CollectLanguagePairsResult,
} from "./types.js";
import { parseProjectPath, extractModSet } from "../_shared/project-path/index.js";
import { parseLangFile } from "../_shared/language/index.js";
import type { LanguageFileFormat } from "../_shared/types.js";
import { loadFileAtRef } from "./load-file-at-ref.js";
import type { DiffFile } from "./types.js";

const LOCALE_RE = /\/(zh_cn|en_us)\.(json|lang)$/;

/**
 * Collect language file pairs (en_us + zh_cn) for both base and head refs
 * from the changed files in a PR diff.
 *
 * For each mod identity, sibling locale paths are derived from the actual
 * changed file path — preserving whatever format (projects/assets/... or
 * the older projects/{version}/...) the changed file uses.
 *
 * Per-file errors (missing files, parse failures) are captured individually
 * and returned in the `errors` array. A missing en_us does not discard a
 * valid zh_cn pair, and vice versa. Client-level failures (network, auth)
 * propagate as thrown exceptions — only 404/file-not-found and parse errors
 * are captured as structured errors without discarding usable data.
 */
export async function collectLanguagePairs(
  ctx: FlowContext,
  baseSha: string,
  headSha: string,
  changedFiles: DiffFile[],
): Promise<CollectLanguagePairsResult> {
  const pairs: LanguageFilePair[] = [];
  const errors: LanguagePairError[] = [];

  const changedPaths = changedFiles.map((f) => f.filename);
  const { identities, entries } = extractModSet(changedPaths);

  for (const identity of identities) {
    const modEntries = entries.filter(
      (e) =>
        e.parsed.slug === identity.slug &&
        e.parsed.gameVersion === identity.gameVersion &&
        e.parsed.modDomain === identity.modDomain,
    );

    if (modEntries.length === 0) continue;

    // Use the first changed zh_cn entry as the canonical path for deriving siblings.
    // This preserves the original path format (projects/assets/... or projects/{v}/...).
    const firstZhCn = modEntries.find((e) =>
      e.parsed.fileName.startsWith("zh_cn"),
    );
    const canonicalEntry = firstZhCn ?? modEntries[0];
    if (!canonicalEntry) continue;

    const format = detectFormat(modEntries.map((e) => e.parsed));
    const canonicalPath = canonicalEntry.rawPath;

    // Derive sibling paths by replacing the locale in the canonical path.
    const baseEnUsPath = deriveSiblingPath(canonicalPath, "en_us", format);
    const baseZhCnPath = canonicalPath;
    const headEnUsPath = deriveSiblingPath(canonicalPath, "en_us", format);
    const headZhCnPath = canonicalPath;

    // Load each file individually so a single failure doesn't discard the pair.
    const [baseEnUs] = await loadOptional(ctx, baseEnUsPath, baseSha, errors);
    const [baseZhCn] = await loadOptional(ctx, baseZhCnPath, baseSha, errors);
    const [headEnUs] = await loadOptional(ctx, headEnUsPath, headSha, errors);
    const [headZhCn] = await loadOptional(ctx, headZhCnPath, headSha, errors);

    // Only skip the pair if zh_cn is missing on BOTH sides.
    if (baseZhCn === null && headZhCn === null) {
      errors.push({
        modPath: identity,
        filePath: canonicalPath,
        ref: `${baseSha.slice(0, 7)} / ${headSha.slice(0, 7)}`,
        message: "zh_cn not found at either base or head ref",
      });
      continue;
    }

    pairs.push({
      modPath: identity,
      format,
      canonicalPath,
      base: {
        enUs: baseEnUs ?? undefined,
        zhCn: baseZhCn ?? undefined,
      },
      head: {
        enUs: headEnUs ?? undefined,
        zhCn: headZhCn ?? undefined,
      },
    });
  }

  // Capture non-mod-path files (changed files outside projects/ hierarchy).
  for (const f of changedFiles) {
    if (parseProjectPath(f.filename)) continue;
    errors.push({
      filePath: f.filename,
      message: "Path does not match known project layout",
    });
  }

  return { pairs, errors };
}

// ──────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────

/**
 * Derive a sibling locale path from a canonical changed path.
 * Replaces the locale segment (zh_cn ↔ en_us) while preserving the
 * full directory structure — works for both assets/ and old-format paths.
 */
function deriveSiblingPath(
  canonicalPath: string,
  targetLocale: "en_us" | "zh_cn",
  format: LanguageFileFormat,
): string {
  return canonicalPath.replace(
    LOCALE_RE,
    `/${targetLocale}.${format}`,
  );
}

function detectFormat(parsed: Array<{ fileName: string }>): LanguageFileFormat {
  const hasLang = parsed.some((p) => p.fileName.endsWith(".lang"));
  return hasLang ? "lang" : "json";
}

/**
 * Load a file and parse it as a language file.
 *
 * Returns [null] for 404 / not-found (soft error — logged to errors array).
 * Returns a parsed result (potentially with parse errors) on success.
 * Propagates (throws) on network/auth/client-level errors so the caller
 * can decide how to handle them.
 */
async function loadOptional(
  ctx: FlowContext,
  path: string,
  ref: string,
  errors: LanguagePairError[],
): Promise<[ParsedLangFile | null]> {
  try {
    const result = await loadFileAtRef(ctx, { path, ref });
    if (result.content === null) {
      return [null];
    }

    const format: LanguageFileFormat = path.endsWith(".lang") ? "lang" : "json";
    const parsed = parseLangFile(result.content, format);

    if (parsed.errors.length > 0) {
      errors.push({
        filePath: path,
        ref: ref.slice(0, 7),
        message: `Parse errors: ${parsed.errors.map((e) => e.message).join("; ")}`,
      });
    }

    return [parsed];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // 404 / not-found = soft error (file simply doesn't exist at this ref)
    if (/404|Not Found|not found/i.test(message)) {
      return [null];
    }

    // Everything else (network, auth, rate limits, size violations) propagates
    throw err;
  }
}
