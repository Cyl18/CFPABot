// src/flows/_internal/refresh-modlist.ts
// Cross-domain internal: refresh the modlist cache from the local git repo.
// Wraps the existing real logic from cron-tasks/modlist-refresh.ts.
// No Flow definition — called by the modlist_refresh Flow and eventually by cron.
//
// Current callers:
// - modlist_refresh (src/flows/cache/modlist_refresh.ts)

import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { FlowContext } from "@/types.js";
import { FlowError } from "./types.js";
import type { RepoHandle } from "@/client/git.js";
import { ensureRepo, getHeadSha } from "@/client/git.js";
import { readModlistCache, writeModlistCache } from "@/client/cache.js";
import type { ModlistCacheFile } from "@/client/cache.js";
import { CACHE_VERSION, REPO } from "@/config.js";
import { acquireLock } from "@/engine/lock.js";
import { repoDirAbs } from "../../runtime-paths.js";
const LOCAL_REPO_DIR = repoDirAbs();
const REPO_URL = `${REPO.BASE_URL}.git`;
const REPO_LOCK_KEY = "modlist-refresh:repo";

export interface ModlistRefreshResult {
  version: number;
  count: number;
  updatedAt: string;
  /** True when an actual cache rewrite happened; false when skipped (HEAD unchanged). */
  refreshed: boolean;
}

export interface RefreshModlistOptions {
  /** Bypass the HEAD-unchanged short-circuit and always refresh. */
  force?: boolean;
}

/** Injectable dependencies for refreshModlist — defaults use real implementations. */
export interface ModlistRefreshDeps {
  /** Fetch latest and reset to origin/defaultBranch. Returns a handle to the local repo. */
  ensureUpToDate: () => Promise<RepoHandle>;
  /** List all tracked file paths from the local repo tree at the given dir. */
  listTree: (dir: string) => Promise<string[]>;
  readCache: () => Promise<ModlistCacheFile | null>;
  writeCache: (file: ModlistCacheFile) => Promise<void>;
}

/** Read HEAD SHA for an existing local repo, or null if the repo dir/.git is absent. */
async function readHeadShaSafe(dir: string, url: string): Promise<string | null> {
  try {
    await stat(join(dir, ".git"));
  } catch {
    return null;
  }
  const handle: RepoHandle = { dir, url };
  return getHeadSha(handle);
}

function defaultDeps(): ModlistRefreshDeps {
  return {
    ensureUpToDate: async () => {
      return await ensureRepo(REPO_URL, LOCAL_REPO_DIR, REPO.DEFAULT_BRANCH);
    },
    listTree: async (dir: string) => {
      const proc = Bun.spawn(
        ["git", "ls-tree", "-r", "--name-only", "HEAD"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) {
        throw new FlowError({
          code: "FAILED",
          message: `git ls-tree failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
          publicMessage: "Failed to read local git repository tree.",
          retryable: true,
        });
      }
      return stdout.split("\n").filter(Boolean);
    },
    readCache: async () => readModlistCache(),
    writeCache: async (file: ModlistCacheFile) => {
      await writeModlistCache(file);
    },
  };
}

/**
 * Refresh the modlist by scanning the repo's project tree.
 *
 * Compares HEAD before and after `ensureUpToDate` (fetch+reset). When HEAD is
 * unchanged and `force` is false, the expensive ls-tree/parse/write is skipped
 * and the existing cache count/updatedAt are returned. The repo lock serializes
 * concurrent webhook and cron access so fetch/reset/ls-tree never interleave.
 *
 * @param ctx      Flow context (logger only — no scope data needed).
 * @param deps     Optional injected dependencies (testability).
 * @param options  Refresh options (force).
 */
export async function refreshModlist(
  ctx: FlowContext,
  deps?: Partial<ModlistRefreshDeps>,
  options?: RefreshModlistOptions,
): Promise<ModlistRefreshResult> {
  const force = options?.force ?? false;
  const { ensureUpToDate, listTree, readCache, writeCache } = { ...defaultDeps(), ...deps };

  // Serialize concurrent webhook + cron access to runtime/repo (fetch/reset/ls-tree).
  const release = await acquireLock(REPO_LOCK_KEY);
  try {
    const headBefore = await readHeadShaSafe(LOCAL_REPO_DIR, REPO_URL);

    // 1. Bring local repo up to date (fetch + reset)
    const handle = await ensureUpToDate();
    const headAfter = await readHeadShaSafe(LOCAL_REPO_DIR, REPO_URL);

    // 2. HEAD-unchanged short-circuit: skip ls-tree entirely (unless forced)
    if (!force && headBefore !== null && headBefore === headAfter) {
      ctx.logger.info({ head: headAfter }, "refreshModlist: HEAD 未变更，跳过 ls-tree、解析与写入");
      const cached = await readCache();
      if (cached) {
        return {
          version: cached.version,
          count: cached.data.length,
          updatedAt: cached.updatedAt,
          refreshed: false,
        };
      }
    }

    // 3. Get full file tree
    const paths = await listTree(handle.dir);

    // 4. Parse project paths to build mod list
    const modVersions = new Map<string, Set<string>>();
    for (const path of paths) {
      const match = path.match(/^projects\/assets\/([^/]+)\/([^/]+)/);
      if (match) {
        const slug = match[1]!;
        const version = match[2]!;
        if (!modVersions.has(slug)) modVersions.set(slug, new Set());
        modVersions.get(slug)!.add(version);
      }
    }

    // 5. Build the modlist entry array
    const modlist = [...modVersions.entries()]
      .map(([slug, versions]) => ({
        slug,
        name: slug,
        cfId: 0,
        versions: [...versions].sort(),
        description: "",
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));

    // 6. Write cache
    const updatedAt = new Date().toISOString();
    await writeCache({ version: CACHE_VERSION, data: modlist, updatedAt });

    ctx.logger.info({ count: modlist.length }, "refreshModlist: 完成");
    return { version: CACHE_VERSION, count: modlist.length, updatedAt, refreshed: true };
  } finally {
    release();
  }
}
