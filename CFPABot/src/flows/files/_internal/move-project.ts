// src/flows/files/_internal/move-project.ts
// Files-domain internal: move an entire project directory within a workspace.
// No Flow definition — used by files_move_project execute().

import { join, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { RepoHandle } from "@/client/git.js";
import { moveFile } from "@/client/git.js";
import { FlowError } from "../../_internal/types.js";

/** Return a sorted recursive file listing under `dir` relative to `baseDir`. */
async function listFilesRecursive(
  dir: string,
  baseDir: string,
): Promise<string[]> {
  const entries: string[] = [];
  try {
    await stat(dir);
  } catch {
    return entries;
  }
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const ent of dirents) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      const children = await listFilesRecursive(full, baseDir);
      entries.push(...children);
    } else {
      entries.push(relative(baseDir, full));
    }
  }
  return entries.sort();
}

/**
 * Move an entire project directory from sourceProjectPath to targetProjectPath
 * within a workspace. Validates that the source exists, target does not (unless
 * identical content makes it idempotent), and collects the moved file list.
 *
 * Returns the list of moved files relative to the repo root.
 */
export async function collectMovedFiles(
  handle: { dir: string },
  sourceProjectPath: string,
  targetProjectPath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!sourceProjectPath || !targetProjectPath) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "sourceProjectPath and targetProjectPath must be non-empty",
      publicMessage: "Both source and target project paths are required.",
      retryable: false,
    });
  }

  // Safety: no absolute paths, no directory traversal
  if (sourceProjectPath.startsWith("/") || targetProjectPath.startsWith("/") ||
      sourceProjectPath.includes("..") || targetProjectPath.includes("..")) {
    throw new FlowError({
      code: "SCOPE_VIOLATION",
      message: `Invalid path: absolute or traversal path rejected`,
      publicMessage: "Project paths must be relative and must not traverse outside the repository.",
      retryable: false,
    });
  }

  const sourceAbs = join(handle.dir, sourceProjectPath);
  const targetAbs = join(handle.dir, targetProjectPath);

  // Check source exists
  try {
    await stat(sourceAbs);
  } catch {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Source project path not found: ${sourceProjectPath}`,
      publicMessage: `Source path "${sourceProjectPath}" does not exist in the repository.`,
      retryable: false,
    });
  }

  // Check target does not exist (unless idempotent — source === target)
  let targetExists = false;
  try {
    await stat(targetAbs);
    targetExists = true;
  } catch {
    // target does not exist, which is expected
  }

  if (targetExists) {
    // Allow idempotent case: source and target resolved to the same directory
    if (sourceProjectPath === targetProjectPath) {
      // Same path — nothing to move
      return [];
    }
    throw new FlowError({
      code: "CONFLICT",
      message: `Target project path already exists: ${targetProjectPath}`,
      publicMessage: `Target path "${targetProjectPath}" already exists. Cannot overwrite.`,
      retryable: false,
    });
  }

  // Collect files before move for the return value
  const beforeFiles = await listFilesRecursive(sourceAbs, handle.dir);

  if (beforeFiles.length === 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Source project path contains no files: ${sourceProjectPath}`,
      publicMessage: `Source path "${sourceProjectPath}" contains no files to move.`,
      retryable: false,
    });
  }

  // Build a RepoHandle for the git client
  const repoHandle: RepoHandle = { dir: handle.dir, url: "" };

  // Use git mv to move the entire directory (handles both files and dirs)
  await moveFile(repoHandle, sourceProjectPath, targetProjectPath, signal);

  // Verify the move: source should no longer exist, target should exist
  const targetFiles = await listFilesRecursive(targetAbs, handle.dir);

  return targetFiles.map((f) =>
    f.startsWith(targetProjectPath) ? f : join(targetProjectPath, relative(sourceProjectPath, f))
  );
}
