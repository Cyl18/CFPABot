// src/flows/files/_internal/replace-text.ts
// Files-domain internal: search-and-replace text in workspace files.
// No Flow definition — used by files_replace_text execute().

import { readFile, writeFile } from "node:fs/promises";
import { FlowError } from "../../_internal/types.js";
import { resolveWorkspacePath } from "../../_internal/workspace-path.js";

export interface ReplacementPreview {
  path: string;
  matchCount: number;
}

export interface ReplacementResult {
  path: string;
  replacementCount: number;
}

/**
 * Preview replacements in workspace files — returns match counts without
 * modifying files. Used to show the user what will change.
 */
export async function previewReplacements(
  handle: { dir: string },
  paths: string[],
  search: string,
  replace: string,
  caseSensitive: boolean,
): Promise<ReplacementPreview[]> {
  const results: ReplacementPreview[] = [];

  for (const filePath of paths) {
    const absPath = resolveWorkspacePath(handle.dir, filePath);
    try {
      const content = await readFile(absPath, "utf-8");
      const flags = caseSensitive ? "g" : "gi";
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, flags);
      const matches = content.match(regex);
      const count = matches ? matches.length : 0;
      if (count > 0) {
        results.push({ path: filePath, matchCount: count });
      }
    } catch {
      // Skip unreadable files (binary, permission, etc.)
    }
  }

  return results;
}

/**
 * Apply literal text replacement to workspace files.
 * Only processes files with at least one match.
 * Binary/unreadable files are silently skipped.
 */
export async function applyTextReplacements(
  handle: { dir: string },
  paths: string[],
  search: string,
  replace: string,
  caseSensitive: boolean,
): Promise<ReplacementResult[]> {
  if (paths.length === 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "No paths provided for text replacement",
      publicMessage: "At least one file path must be specified for text replacement.",
      retryable: false,
    });
  }

  if (!search) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "Empty search string",
      publicMessage: "Search string cannot be empty.",
      retryable: false,
    });
  }

  const results: ReplacementResult[] = [];
  const flags = caseSensitive ? "g" : "gi";
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, flags);

  for (const filePath of paths) {
    const absPath = resolveWorkspacePath(handle.dir, filePath);
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      // Skip unreadable files
      continue;
    }

    const newContent = content.replace(regex, replace);
    if (newContent !== content) {
      await writeFile(absPath, newContent, "utf-8");
      const matchCount = (content.match(regex) ?? []).length;
      results.push({ path: filePath, replacementCount: matchCount });
    }
  }

  return results;
}
