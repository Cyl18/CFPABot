// src/engine/pr-index.ts
// Single source of truth for open PR summaries.
// Stateful in-memory index with disk persistence.
//
// Stores open PR entries in an in-memory Map and persists atomically
// to runtime/cache/pr_index.json.  Webhook and cron paths update the
// index through upsert/remove; full-list operations use replaceAll.

import { readJsonFile, writeJsonFile } from "../_shared/fs-utils.js";
import { PR_INDEX_PATH } from "../runtime-paths.js";
import { CACHE_VERSION } from "../config.js";
import type { Logger } from "../types.js";

// Module logger — injected once at bootstrap (see deps.ts).
let _logger: Logger | null = null;
export function initPrIndexLogger(logger: Logger): void {
  _logger = logger;
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface PrIndexEntry {
  number: number;
  title: string;
  state: "open" | "closed";
  /** GitHub login of the author. */
  author: string;
  labels: { name: string }[];
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  headSha: string;
  htmlUrl: string;
  draft?: boolean;
}

interface PrIndexFile {
  version: number;
  updatedAt: string;
  data: PrIndexEntry[];
}


export interface PrIndexMeta {
  count: number;
  updatedAt: string | null;
  version: number;
}



// ─── In-memory state ───────────────────────────────────────────────────────

/** number → PrIndexEntry.  Only open PRs are stored; closed PRs are removed. */
const entries = new Map<number, PrIndexEntry>();

/** Timestamp of the last successful disk write, or null if never written. */
let diskUpdatedAt: string | null = null;
export interface PrIndexListOptions {
  state?: "open" | "closed" | "all";
  sort?: "created" | "updated" | "created_desc" | "updated_desc" | "number_desc";
}
/** True after loadFromDisk has completed (even if the file was missing/empty). */
let loaded = false;
const CACHE_PATH = PR_INDEX_PATH;
/**
 * Write-behind debounce timer for upsert/remove.
 * Multiple mutations within ~50ms are coalesced into a single disk write.
 */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWrite: Promise<void> | null = null;

// ─── Internal helpers ──────────────────────────────────────────────────────

function sortEntries(list: PrIndexEntry[], sort?: string): PrIndexEntry[] {
  const sorted = [...list];
  switch (sort) {
    case "created":
      sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      break;
    case "created_desc":
    case "number_desc":
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      break;
    case "updated":
      sorted.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      break;
    case "updated_desc":
    default:
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      break;
  }
  return sorted;
}

async function atomicWrite(data: PrIndexEntry[]): Promise<void> {
  const file: PrIndexFile = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    data,
  };
  await writeJsonFile(CACHE_PATH, file);
  diskUpdatedAt = file.updatedAt;
}

/** Debounced disk write that coalesces pending mutations. */
function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const write = atomicWrite([...entries.values()]);
    write.then(
      () => { pendingWrite = null; },
      (err) => {
        // 磁盘写失败不能变成 unhandled rejection(全局 handler 会 exit(1));
        // 索引仍在内存中,下次 upsert/remove 会重新调度写盘。
        pendingWrite = null;
        _logger?.error({ err: String(err) }, "pr-index 磁盘写入失败");
      },
    );
    pendingWrite = write;
  }, 50);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Load the index from disk.  Safe to call multiple times — subsequent
 * calls are no-ops once `loaded` is true. On I/O failure `loaded` stays
 * false so a later call retries (a permanently empty index would make
 * webhook lookups miss every open PR).
 */
export async function loadFromDisk(): Promise<void> {
  if (loaded) return;

  try {
    const raw = await readJsonFile<PrIndexFile>(CACHE_PATH);
    if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.data)) {
      // Missing, version mismatch, or corrupt — start with empty index
      loaded = true;
      return;
    }

    for (const entry of raw.data) {
      entries.set(entry.number, entry);
    }
    diskUpdatedAt = raw.updatedAt ?? null;
    loaded = true;
  } catch (err) {
    // I/O 失败(非损坏)— 不置 loaded,保留重试机会
    _logger?.warn({ err: String(err) }, "pr-index 磁盘读取失败，稍后重试");
  }
}

/**
 * Replace the entire index atomically.
 * Concurrent calls are serialized — each call chains after the previous,
 * so the last caller's data always wins.
 */
let replaceChain: Promise<void> = Promise.resolve();

export async function replaceAll(newEntries: PrIndexEntry[]): Promise<void> {
  const run = async (): Promise<void> => {
    entries.clear();
    for (const e of newEntries) {
      entries.set(e.number, e);
    }
    // Cancel any pending debounced write (upsert/remove will re-schedule)
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    // Wait for a pending debounced write to finish before replacing
    if (pendingWrite) await pendingWrite;

    await atomicWrite(newEntries);
  };

  const next = replaceChain.then(run, run);
  replaceChain = next.catch(() => {});
  return next;
}

/**
 * Insert or update a single entry.  Debounced disk write (~50ms).
 */
export async function upsert(entry: PrIndexEntry): Promise<void> {
  entries.set(entry.number, entry);
  scheduleWrite();
}

/**
 * Remove a PR from the index.  Debounced disk write (~50ms).
 */
export async function remove(prNumber: number): Promise<void> {
  entries.delete(prNumber);
  scheduleWrite();
}

/**
 * Return the list of entries matching the given options.
 * Results are a shallow copy — safe to iterate but not to mutate.
 */
export function list(opts?: PrIndexListOptions): PrIndexEntry[] {
  let result: PrIndexEntry[];

  const state = opts?.state ?? "open";
  if (state === "all") {
    result = [...entries.values()];
  } else {
    result = [...entries.values()].filter((e) => e.state === state);
  }

  return sortEntries(result, opts?.sort);
}

/** Look up a single entry by PR number. Returns undefined if not in index. */
export function get(prNumber: number): PrIndexEntry | undefined {
  return entries.get(prNumber);
}

/** Return the number of open PRs currently in the index. */
export function openCount(): number {
  let count = 0;
  for (const e of entries.values()) {
    if (e.state === "open") count++;
  }
  return count;
}

/** Return metadata about the index. */
export function getMeta(): PrIndexMeta {
  return {
    count: entries.size,
    updatedAt: diskUpdatedAt,
    version: CACHE_VERSION,
  };
}

/** Returns true if the index has been loaded from disk (even if empty). */
export function isLoaded(): boolean {
  return loaded;
}

// ─── Mapping helper ────────────────────────────────────────────────────────

/**
 * Map a PullRequestListItem from the GitHub list API into a PrIndexEntry.
 */
export function mapPrIndexEntry(pr: {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  user: { login: string; id: number } | null;
  labels: Array<{ name: string; color?: string }>;
  created_at: string;
  updated_at: string;
  head?: { sha: string };
  draft?: boolean;
}): PrIndexEntry {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    author: pr.user?.login ?? "",
    labels: pr.labels.map((l) => ({ name: l.name })),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at,
    headSha: pr.head?.sha ?? "",
    htmlUrl: pr.html_url,
    draft: pr.draft,
  };
}
