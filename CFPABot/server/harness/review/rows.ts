import type {
  ReviewRowView,
  ReviewRowsPage,
  ReviewThread,
  WorkspaceBrief,
} from "@cfpa/contracts/api";
import { matchTerms, type TermIndex } from "@cfpa/review-core/domain/terms";
import { findingHistogram, selectRows, workspaceKey, type Pack, type PackWorkspace } from "@cfpa/review-core/pack";
import type { SelectedRow } from "@cfpa/review-core/pack";
import { glossaryTerms } from "../../domain/glossary.ts";
import { prdata } from "../../prdata.ts";
import { pageOf } from "../result.ts";
import { loadPack } from "../pack.ts";
import { nextPageUri } from "../uri.ts";
import { threadsOf, type ThreadsView } from "./threads.ts";

export type RowsFilter = "reviewable" | "changed" | "flagged" | "all";

export interface RowsInclude {
  terms: boolean;
  threads: boolean;
  duplicates: boolean;
  patch: boolean;
}

export interface RowsOptions {
  filter: RowsFilter;
  workspace?: string;
  prefix?: string;
  keys?: string[];
  query?: string;
  offset?: number;
  limit?: number;
  rebuild?: boolean;
  include: RowsInclude;
}

export interface RowsInput {
  pack: Pack;
  threads: ThreadsView;
  terms: TermIndex | null;
  patches: Map<string, string | undefined>;
}

export function defaultRowsInclude(): RowsInclude {
  return { terms: true, threads: true, duplicates: true, patch: false };
}

export function workspaceBriefs(pack: Pack): WorkspaceBrief[] {
  return pack.workspaces.map((workspace) => ({
    workspace: workspaceKey(workspace),
    format: workspace.format,
    enPath: workspace.enPath,
    zhPath: workspace.zhPath,
    counts: workspace.counts,
    histogram: findingHistogram(workspace),
    duplicates: workspace.duplicates.length,
  }));
}

function reviewableCount(pack: Pack): number {
  let count = 0;
  for (const workspace of pack.workspaces) {
    for (const row of workspace.rows) if (row.changed && row.inHunk) count += 1;
  }
  return count;
}

function threadIndex(threads: readonly ReviewThread[]): Map<string, ReviewThread[]> {
  const index = new Map<string, ReviewThread[]>();
  const push = (path: string, line: number, thread: ReviewThread): void => {
    const key = `${path}\u0000${line}`;
    const list = index.get(key);
    if (list === undefined) index.set(key, [thread]);
    else if (!list.includes(thread)) list.push(thread);
  };
  for (const thread of threads) {
    if (thread.line !== null) push(thread.path, thread.line, thread);
    if (thread.originalLine !== null && thread.originalLine !== thread.line) push(thread.path, thread.originalLine, thread);
  }
  return index;
}

function duplicateOf(workspace: PackWorkspace, key: string, zh: string | undefined): ReviewRowView["duplicate"] {
  if (zh === undefined || zh === "") return undefined;
  const group = workspace.duplicates.find((entry) => entry.zh === zh && entry.keys.includes(key));
  if (group === undefined) return undefined;
  const keys = group.keys.filter((entry) => entry !== key);
  return keys.length === 0 ? undefined : { zh: group.zh, keys };
}

function pageParams(options: RowsOptions): URLSearchParams {
  const params = new URLSearchParams();
  params.set("filter", options.filter);
  if (options.workspace !== undefined) params.set("workspace", options.workspace);
  if (options.prefix !== undefined) params.set("prefix", options.prefix);
  if (options.keys !== undefined && options.keys.length > 0) params.set("keys", options.keys.join(","));
  if (options.query !== undefined) params.set("query", options.query);
  const include = Object.entries(options.include)
    .filter(([, value]) => value)
    .map(([name]) => name);
  params.set("include", include.length > 0 ? include.join(",") : "none");
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return params;
}

/** 纯组装：分页、术语、线程、重复译文和 patch 都在这一页里对齐，模型不再自己 join。 */
export function rowsPage(input: RowsInput, options: RowsOptions): ReviewRowsPage {
  const { pack } = input;
  const filter = options.filter === "reviewable" ? "changed" : options.filter;
  let selected = selectRows(pack, {
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.keys === undefined ? {} : { keys: options.keys }),
    ...(options.query === undefined ? {} : { query: options.query }),
    filter,
  });
  if (options.filter === "reviewable") selected = selected.filter((entry) => entry.row.inHunk);
  if (options.prefix !== undefined && options.prefix !== "") {
    const prefix = options.prefix;
    selected = selected.filter((entry) => entry.row.key.startsWith(prefix));
  }
  const page = pageOf(options.offset, options.limit, 200, 100);
  const slice = selected.slice(page.offset, page.offset + page.limit);
  const nextOffset = page.offset + slice.length < selected.length ? page.offset + slice.length : null;
  const threads = input.threads.available ? threadIndex(input.threads.threads) : new Map<string, ReviewThread[]>();
  const patchTargets = new Set<string>();
  const rows: ReviewRowView[] = slice.map(({ workspace, row }: SelectedRow) => {
    const path = workspace.zhPath;
    const found = path === null ? undefined : threads.get(`${path}\u0000${row.line ?? -1}`);
    const duplicate = options.include.duplicates ? duplicateOf(workspace, row.key, row.headZh) : undefined;
    if (options.include.patch && path !== null) patchTargets.add(path);
    return {
      workspace: workspaceKey(workspace),
      path,
      key: row.key,
      ...(row.headEn === undefined ? {} : { en: row.headEn }),
      ...(row.headZh === undefined ? {} : { zh: row.headZh }),
      ...(row.baseEn === undefined ? {} : { baseEn: row.baseEn }),
      ...(row.baseZh === undefined ? {} : { baseZh: row.baseZh }),
      line: row.line,
      inHunk: row.inHunk,
      changed: row.changed,
      findings: row.findings,
      ...(options.include.terms && input.terms !== null
        ? {
            terms: matchTerms(
              input.terms,
              row.key,
              row.headEn ?? "",
              row.headZh ?? "",
              workspace.version,
            ).slice(0, 6),
          }
        : {}),
      ...(options.include.threads && found !== undefined ? { threads: found } : {}),
      ...(duplicate === undefined ? {} : { duplicate }),
    };
  });
  const patches: Record<string, string> = {};
  if (options.include.patch) {
    for (const path of patchTargets) {
      const patch = input.patches.get(path);
      if (patch !== undefined && patch !== "") patches[path] = patch;
    }
  }
  const params = pageParams(options);
  const next = nextPageUri(`pr://${pack.prNumber}/rows`, params, nextOffset);
  const remaining = selected.length - page.offset - rows.length;
  return {
    next,
    hint:
      next === null
        ? `本页 ${rows.length} 行，已取完 ${selected.length} 行。`
        : `本页 ${rows.length} 行，还剩 ${remaining} 行；继续 read ${next}`,
    prNumber: pack.prNumber,
    headSha: pack.headSha,
    total: selected.length,
    offset: page.offset,
    limit: page.limit,
    nextOffset,
    counts: {
      workspaces: pack.workspaces.length,
      rows: pack.counts.rows,
      changed: pack.counts.changed,
      flagged: pack.counts.flagged,
      reviewable: reviewableCount(pack),
    },
    workspaces: workspaceBriefs(pack),
    rows,
    ...(Object.keys(patches).length === 0 ? {} : { patches }),
    commentsAvailable: input.threads.available,
    termsLoaded: input.terms !== null,
  };
}

export async function rowsOf(n: number, options: RowsOptions): Promise<ReviewRowsPage> {
  const pack = await loadPack(n, options.rebuild === true);
  const threads = options.include.threads
    ? await threadsOf(n)
    : ({ available: false, headSha: null, pendingReviewId: null, threads: [] } satisfies ThreadsView);
  return rowsForPack(n, pack, threads, options);
}

/** 简报已经取过 pack 与线程时直接复用，避免同一轮再拉一次 GraphQL。 */
export async function rowsForPack(
  n: number,
  pack: Pack,
  threads: ThreadsView,
  options: RowsOptions,
): Promise<ReviewRowsPage> {
  const terms = options.include.terms ? await glossaryTerms() : null;
  const patches =
    options.include.patch
      ? new Map((await prdata.files(n)).files.map((file) => [file.path, file.patch]))
      : new Map<string, string | undefined>();
  return rowsPage({ pack, threads, terms, patches }, options);
}
