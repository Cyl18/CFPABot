// src/flows/_internal/workspace-path.ts
// Cross-domain internal: confine a user-supplied relative path to a PR
// workspace. Files-domain mutation flows (sort-keys, format, replace,
// fetch-en-us) join user input onto the workspace dir — a `..`/absolute
// path could read or overwrite files outside the temp clone (server
// config, .env, session records). Lexical checks only: the command layer
// enforces the `projects/` contract, and symlinks are out of scope for
// the actual threat model (repo-relative paths under a trusted admin).

import { isAbsolute, join, normalize, sep } from "node:path";
import { FlowError } from "./types.js";

/**
 * Resolve `relativePath` against a workspace dir, rejecting anything that
 * escapes the workspace: absolute paths, Windows drive/UNC paths, and any
 * `..` traversal that leaves the dir. Throws FlowError(INVALID_INPUT).
 */
export function resolveWorkspacePath(dir: string, relativePath: string): string {
  if (!relativePath || relativePath.length === 0) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: "Empty workspace path",
      publicMessage: "文件路径不能为空。",
      retryable: false,
    });
  }
  if (
    isAbsolute(relativePath) ||
    /^[a-zA-Z]:[\\/]/.test(relativePath) ||
    relativePath.startsWith("\\\\")
  ) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Absolute path not allowed: ${relativePath}`,
      publicMessage: `不允许绝对路径：${relativePath}`,
      retryable: false,
    });
  }
  const joined = join(dir, relativePath);
  const normalized = normalize(joined);
  const root = normalize(dir);
  if (normalized !== root && !normalized.startsWith(root + sep)) {
    throw new FlowError({
      code: "INVALID_INPUT",
      message: `Path escapes workspace: ${relativePath}`,
      publicMessage: `路径越界：${relativePath}`,
      retryable: false,
    });
  }
  return joined;
}
