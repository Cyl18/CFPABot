// src/flows/files/_internal/rename-file.ts
// Files-domain internal: rename a single file within a workspace.
// No Flow definition — used by files_rename execute().

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { RepoHandle } from "@/client/git.js";
import { moveFile } from "@/client/git.js";
import { FlowError } from "../../_internal/types.js";
import { randomUUID } from "node:crypto";

/**
 * Rename a file within the workspace. Handles case-only renames safely
 * (two-step via temp name) and validates that the target does not exist.
 *
 * Returns the final relative path.
 */
export async function safeRename(
  handle: { dir: string },
  sourcePath: string,
  targetPath: string,
): Promise<string> {
  if (!sourcePath || !targetPath) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "sourcePath and targetPath must be non-empty",
      publicMessage: "Both source and target paths are required.",
      retryable: false,
    });
  }

  // Safety: no absolute paths, no directory traversal
  if (sourcePath.startsWith("/") || targetPath.startsWith("/") ||
      sourcePath.includes("..") || targetPath.includes("..")) {
    throw new FlowError({
      code: "SCOPE_VIOLATION",
      message: `Path rejected (absolute or traversal): source=${sourcePath} target=${targetPath}`,
      publicMessage: "Paths must be relative and must not traverse outside the repository.",
      retryable: false,
    });
  }

  const sourceAbs = join(handle.dir, sourcePath);
  const targetAbs = join(handle.dir, targetPath);

  // Check source exists
  try {
    await stat(sourceAbs);
  } catch {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Source file not found: ${sourcePath}`,
      publicMessage: `Source file "${sourcePath}" does not exist in the repository.`,
      retryable: false,
    });
  }

  // Check target does not already exist
  try {
    await stat(targetAbs);
    throw new FlowError({
      code: "CONFLICT",
      message: `Target file already exists: ${targetPath}`,
      publicMessage: `Target file "${targetPath}" already exists. Cannot overwrite.`,
      retryable: false,
    });
  } catch (err) {
    if (err instanceof FlowError) throw err;
    // target does not exist — expected
  }

  // Detect case-only rename (same path except casing)
  const isCaseOnly = sourcePath.toLowerCase() === targetPath.toLowerCase() &&
                     sourcePath !== targetPath;

  const repoHandle: RepoHandle = { dir: handle.dir, url: "" };

  if (isCaseOnly) {
    // Case-only rename: two-step rename via a temporary name to avoid
    // filesystem collision on case-insensitive platforms (Windows, macOS).
    const tempName = `__cfpa_temp_${randomUUID()}__${sourcePath}`;
    await moveFile(repoHandle, sourcePath, tempName);
    await moveFile(repoHandle, tempName, targetPath);
  } else {
    await moveFile(repoHandle, sourcePath, targetPath);
  }

  return targetPath;
}
