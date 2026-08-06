// src/flows/_internal/load-file-at-ref.ts
// Cross-domain internal: load a file from a specific ref (commit SHA) in the
// configured repo. Only reads from allowed repos and explicit SHAs.
// No Flow definition — called by collect-language-pairs and others.

import type { FlowContext } from "../../types.js";
import type { FileAtRef, LoadFileAtRefOptions } from "./types.js";
import { buildRawBlobUrl, fetchRawContent } from "../../client/github/helpers.js";

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB

/**
 * SHA hex character check (loose — validates 40 hex chars).
 */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Load a file's content at a specific ref (must be a full commit SHA).
 *
 * First attempts the structured GitHubClient.fetchFileContent (which parses
 * JSON language files). Falls back to raw.githubusercontent.com for non-JSON
 * content (.lang files, text files, etc.).
 *
 * Security: ref MUST be a 40-char hex SHA, not a branch/tag name.
 * Only the configured repo (ctx.repo) is accessed.
 */
export async function loadFileAtRef(
  ctx: FlowContext,
  options: LoadFileAtRefOptions,
): Promise<FileAtRef> {
  const { path, ref, maxBytes = DEFAULT_MAX_BYTES } = options;

  // Enforce SHA-only refs (no branch/tag names)
  if (!SHA_RE.test(ref)) {
    throw new Error(
      `SECURITY: ref must be a 40-char commit SHA, got "${ref.slice(0, 12)}…"`,
    );
  }

  // Enforce path safety
  if (path.includes("..") || path.startsWith("/")) {
    throw new Error(`SECURITY: invalid path "${path}"`);
  }

  // Try structured fetch first (handles JSON lang files)
  const jsonResult = await ctx.github.fetchFileContent(path, ref);
  if (jsonResult !== null) {
    return {
      path,
      ref,
      content: JSON.stringify(jsonResult),
      size: new TextEncoder().encode(JSON.stringify(jsonResult)).length,
    };
  }

  // Fallback: raw content for non-JSON files (.lang, etc.)
  const url = buildRawBlobUrl(ctx.repo.owner, ctx.repo.name, path, ref);
  const rawContent = await fetchRawContent(url);

  if (rawContent === null) {
    return { path, ref, content: null, size: 0 };
  }

  if (rawContent.length > maxBytes) {
    throw new Error(
      `File too large: ${path} at ${ref.slice(0, 7)} is ${rawContent.length} bytes (max ${maxBytes})`,
    );
  }

  return {
    path,
    ref,
    content: rawContent,
    size: rawContent.length,
  };
}

/**
 * Load a JSON language file at a ref, returning the parsed entries.
 * Returns null if the file doesn't exist. Throws if content isn't valid JSON.
 */
export async function loadJsonLangAtRef(
  ctx: FlowContext,
  path: string,
  ref: string,
): Promise<Record<string, string> | null> {
  const result = await loadFileAtRef(ctx, { path, ref });

  if (result.content === null) return null;

  // The result content is already JSON-stringified by fetchFileContent
  // or raw text from the fallback. Either way, parse it.
  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") entries[k] = v;
    }
    return entries;
  } catch {
    throw new Error(`File is not valid JSON: ${path} at ${ref.slice(0, 7)}`);
  }
}
