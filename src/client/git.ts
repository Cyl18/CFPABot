// Alias for the platform timer handle returned by setTimeout.
// Avoids leaking `ReturnType<typeof setTimeout>` through the module's public/internal contracts.
type TimerHandle = ReturnType<typeof setTimeout>;
// Local Git operations via child_process (Bun.spawn).
// Manages a lightweight local clone for file manipulation.

import { join } from "node:path";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import type { Logger } from "../types.js";

// Module-level logger injection — set once at bootstrap via initGitLogger().
// 避免本模块直接依赖 pino;未注入时静默降级(不打印)。
let _logger: Logger | null = null;
export function initGitLogger(logger: Logger): void {
  _logger = logger;
}

/**
 * A handle to a local git repository clone.
 */
export interface RepoHandle {
  /** Absolute path to the working directory */
  dir: string;
  /** Remote URL the repo was cloned from */
  url: string;
}

const PUSH_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 120_000;

/**
 * Stage all changed files and create a commit.
 *
 * @param handle   Repo handle.
 * @param message  Commit message.
 * @param user     Git user identity for the commit (login or name).
 * @returns The new HEAD SHA.
 */
export async function commit(
  handle: RepoHandle,
  message: string,
  user: string,
): Promise<string> {
  await runGit(handle, ["add", "-A"]);
  await runGit(handle, [
    "-c", `user.name=${user}`,
    "-c", `user.email=${user}@users.noreply.github.com`,
    "commit", "-m", message,
  ]);
  return getHeadSha(handle);
}

/**
 * Push committed changes to the remote.
 * Uses `git push` - assumes the remote is `origin` and the branch is `HEAD`.
 */
export async function push(handle: RepoHandle): Promise<void> {
  await runGit(handle, ["push", "origin", "HEAD"], PUSH_TIMEOUT_MS);
}

/**
 * Revert the most recent commit (or a specific commit by hash).
 *
 * If no hash is provided, performs `git reset --soft HEAD~1` to
 * undo the latest commit while keeping changes staged.
 * If a hash is provided, performs `git revert --no-edit <hash>`.
 *
 * @param handle  Repo handle.
 * @param hash    Optional commit hash to revert. Defaults to HEAD (undo last commit).
 */
export async function revert(
  handle: RepoHandle,
  hash?: string,
): Promise<void> {
  if (hash) {
    await runGit(handle, ["revert", "--no-edit", hash]);
  } else {
    await runGit(handle, ["reset", "--soft", "HEAD~1"]);
  }
}

/**
 * Move (rename) a file in the repository.
 *
 * Uses `git mv` when available; falls back to manual file move +
 * `git add` if git mv fails (e.g., moving across un-tracked boundaries).
 *
 * @param handle  Repo handle.
 * @param from    Current file path (relative to repo root).
 * @param to      New file path (relative to repo root).
 */
export async function moveFile(
  handle: RepoHandle,
  from: string,
  to: string,
): Promise<void> {
  const fromAbs = join(handle.dir, from);
  const toAbs = join(handle.dir, to);

  // Ensure target directory exists
  const toDir = toAbs.replace(/[\\/][^\\/]+$/, "");
  try {
    await stat(toDir);
  } catch {
    await mkdir(toDir, { recursive: true });
  }

  try {
    await runGit(handle, ["mv", from, to]);
  } catch {
    // git mv failed - do a manual move + stage
    await Bun.write(toAbs, Bun.file(fromAbs));
    // Remove source
    unlinkSync(fromAbs);
    await runGit(handle, ["add", "-A"]);
  }
}

/**
 * Get the current HEAD commit SHA.
 */
export async function getHeadSha(handle: RepoHandle): Promise<string> {
  const result = await runGit(handle, ["rev-parse", "HEAD"]);
  return result.trim();
}

/**
 * Get the commit message of the most recent commit.
 */
export async function getHeadMessage(handle: RepoHandle): Promise<string> {
  const result = await runGit(handle, ["log", "-1", "--format=%B"]);
  return result.trim();
}

/**
 * Amend the most recent commit with a new message.
 * Unlike `commit()`, this does NOT run `git add -A` — only the message changes.
 */
export async function amendCommit(handle: RepoHandle, message: string, user: string): Promise<string> {
  await runGit(handle, [
    "-c", `user.name=${user}`,
    "-c", `user.email=${user}@users.noreply.github.com`,
    "commit", "--amend", "-m", message,
  ]);
  return getHeadSha(handle);
}

/**
 * Force-push the current HEAD branch (squash/amend workflows).
 * Uses --force-with-lease to avoid clobbering upstream changes.
 */
export async function pushWithForceLease(handle: RepoHandle): Promise<void> {
  await runGit(handle, ["push", "origin", "HEAD", "--force-with-lease"], PUSH_TIMEOUT_MS);
}

/** Delete stale .git/index.lock if present (e.g. from a previous crash). */
function cleanStaleLock(gitDir: string): void {
  const lockFile = join(gitDir, "index.lock");
  if (existsSync(lockFile)) {
    rmSync(lockFile);
  }
}

/**
 * Ensure a local repo exists and is up-to-date.
 * If the directory already contains a git repo, fetch + reset to origin/branch.
 * Otherwise, perform a fresh shallow clone.
 *
 * @param url     Remote URL to clone.
 * @param dir     Local directory path for the repo.
 * @param branch  Branch to track (default "main").
 */
export async function ensureRepo(url: string, dir: string, branch: string = "main"): Promise<RepoHandle> {
  const gitDir = join(dir, ".git");
  let repoExists = false;
  try {
    await stat(gitDir);
    repoExists = true;
  } catch {
    // directory doesn't exist yet
  }

  if (repoExists) {
    cleanStaleLock(gitDir);
    const handle: RepoHandle = { dir, url };
    await runGit(handle, ["fetch", "--depth", "1", "origin", branch], FETCH_TIMEOUT_MS);
    await runGit(handle, ["reset", "--hard", `origin/${branch}`], FETCH_TIMEOUT_MS);
    return handle;
  } else {
    // Ensure parent directory exists
    const parentDir = dir.replace(/[\\/][^\\/]+$/, "");
    if (parentDir) {
      try {
        await stat(parentDir);
      } catch {
        await mkdir(parentDir, { recursive: true });
      }
    }
    await runGit(null, ["clone", "--depth", "1", "--branch", branch, url, dir], FETCH_TIMEOUT_MS);
    return { dir, url };
  }
}

// ---- internal ----

// 兜底读取超时:超时 kill 只终止 git 主进程,其子进程(git-remote-https/ssh)
// 可能仍持有 stdout/stderr 管道——若无兜底,读取将永远等不到 EOF 而挂起
// (恰发生在超时本应兜底的远端挂起场景)。
const READ_TIMEOUT_MS = 10_000;

async function readStream(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let settled = false;
  const textPromise = (async (): Promise<string> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    settled = true;
    return Buffer.concat(chunks).toString("utf-8");
  })();
  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => resolve(""), timeoutMs);
  });
  const result = await Promise.race([textPromise, timeoutPromise]);
  if (!settled) {
    // 超时:取消底层流,释放挂起的 read()。
    reader.cancel().catch(() => {});
  }
  return result;
}

async function runGit(
  handle: RepoHandle | null,
  args: string[],
  timeoutMs?: number,
): Promise<string> {
  const cwd = handle?.dir ?? process.cwd();

  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutTimer: TimerHandle | undefined;
  let timedOut = false;

  if (timeoutMs != null) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
  }

  try {
    // 并行读输出与等退出;kill 后子进程仍持有管道时读取由
    // readStream 的兜底超时保护,不会永久挂起。
    const stdoutPromise = readStream(proc.stdout, READ_TIMEOUT_MS);
    const stderrPromise = readStream(proc.stderr, READ_TIMEOUT_MS);
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    if (timedOut) {
      throw new Error(`Git command timed out after ${timeoutMs}ms: git ${args.join(" ")}\n${stderr.trim() || stdout.trim()}`);
    }

    if (exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    }

    if (stderr.trim()) {
      // git 退出码为 0 但 stderr 有输出(常见于 git 的提示信息)— 记入日志通道
      _logger?.warn({ stderr: stderr.trim(), args }, `git ${args.join(" ")} (exit 0): ${stderr.trim()}`);
    }

    return stdout;
  } finally {
    clearTimeout(timeoutTimer);
  }
}
