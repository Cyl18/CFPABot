// src/flows/files/_internal/sort-keys.ts
// Files-domain internal: sort JSON language file keys alphabetically.
// No Flow definition — used by files_sort_keys execute().

import { readFile, writeFile } from "node:fs/promises";
import { FlowError } from "../../_internal/types.js";
import { resolveWorkspacePath } from "../../_internal/workspace-path.js";
import { parseLangFile } from "../../_shared/language/index.js";

export interface SortResult {
  path: string;
  keyCount: number;
}

/**
 * Sort keys in a JSON language file. Validates that the file:
 * - Is valid JSON
 * - Contains only string values
 * - Can be parsed as a language file
 *
 * Returns the path and key count if the file was modified.
 */
export async function sortJsonLangKeys(
  handle: { dir: string },
  filePath: string,
): Promise<SortResult> {
  const absPath = resolveWorkspacePath(handle.dir, filePath);

  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Cannot read file: ${filePath}`,
      publicMessage: `File "${filePath}" could not be read.`,
      retryable: false,
    });
  }

  // Parse and validate
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Invalid JSON in ${filePath}: ${(e as Error).message}`,
      publicMessage: `File "${filePath}" is not valid JSON.`,
      retryable: false,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `File ${filePath} is not a JSON object`,
      publicMessage: `File "${filePath}" must be a JSON object (key-value pairs).`,
      retryable: false,
    });
  }

  // Validate all values are strings
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Non-string value for key "${key}" in ${filePath}: ${typeof value}`,
        publicMessage: `Key "${key}" in "${filePath}" has a non-string value. Only string values are supported.`,
        retryable: false,
      });
    }
  }

  const obj = parsed as Record<string, string>;
  const currentKeys = Object.keys(obj);
  const sortedKeys = [...currentKeys].sort((a, b) => a.localeCompare(b));

  // Check if already sorted
  const alreadySorted = currentKeys.every((k, i) => k === sortedKeys[i]);
  if (alreadySorted) {
    return { path: filePath, keyCount: currentKeys.length };
  }

  // Build sorted object and serialize with 4-space indent + trailing newline
  const sorted: Record<string, string> = {};
  for (const key of sortedKeys) {
    sorted[key] = obj[key]!;
  }

  const output = `${JSON.stringify(sorted, null, 4)}\n`;
  await writeFile(absPath, output, "utf-8");

  return { path: filePath, keyCount: sortedKeys.length };
}
