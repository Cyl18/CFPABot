import type {
  ReviewPlan,
  ReviewRowView,
  ReviewRowsPage,
  ReviewSlice,
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
  /** 仅人类 HTTP 分页与兼容旧调用；agent 主流程不用。 */
  offset?: number;
  limit?: number;
  slice?: string;
  rebuild?: boolean;
  include: RowsInclude;
}

export interface RowsInput {
  pack: Pack;
  threads: ThreadsView;
  terms: TermIndex | null;
  patches: Map<string, string | undefined>;
}

export interface ReviewRowsResult {
  page: ReviewRowsPage;
  plan: ReviewPlan;
}

interface PlannedSlice extends ReviewSlice {
  start: number;
  end: number;
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

const ROWS_PAGE_BYTES = 28_000;
const SLICE_MAX_ROWS = 300;

function rowBytes(row: ReviewRowView): number {
  return Buffer.byteLength(JSON.stringify(row));
}

/** 同组分片：键的前三段（如 slate_work.page.<page>）整组进同片，回填才有相邻条目可拼。 */
function sliceGroup(key: string): string {
  const parts = key.split(".");
  return parts.length > 3 ? parts.slice(0, 3).join(".") : key;
}

function filterParams(options: RowsOptions): URLSearchParams {
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
  return params;
}

function pageParams(options: RowsOptions): URLSearchParams {
  const params = filterParams(options);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return params;
}

function sliceParams(options: RowsOptions, id: string): URLSearchParams {
  const params = filterParams(options);
  params.set("slice", id);
  return params;
}

function selectForOptions(pack: Pack, options: RowsOptions): SelectedRow[] {
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
  return selected;
}

function buildRows(input: RowsInput, options: RowsOptions, selected: readonly SelectedRow[]): ReviewRowView[] {
  const threads = input.threads.available ? threadIndex(input.threads.threads) : new Map<string, ReviewThread[]>();
  return selected.map(({ workspace, row }: SelectedRow) => {
    const path = workspace.zhPath;
    const found = path === null ? undefined : threads.get(`${path}\u0000${row.line ?? -1}`);
    const duplicate = options.include.duplicates ? duplicateOf(workspace, row.key, row.headZh) : undefined;
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
}

function patchesOf(input: RowsInput, options: RowsOptions, rows: readonly ReviewRowView[]): Record<string, string> | undefined {
  if (!options.include.patch) return undefined;
  const patches: Record<string, string> = {};
  for (const path of new Set(rows.map((row) => row.path).filter((path): path is string => path !== null))) {
    const patch = input.patches.get(path);
    if (patch !== undefined && patch !== "") patches[path] = patch;
  }
  return Object.keys(patches).length === 0 ? undefined : patches;
}

function countsOf(pack: Pack): ReviewRowsPage["counts"] {
  return {
    workspaces: pack.workspaces.length,
    rows: pack.counts.rows,
    changed: pack.counts.changed,
    flagged: pack.counts.flagged,
    reviewable: reviewableCount(pack),
  };
}

function basePage(
  input: RowsInput,
  options: RowsOptions,
  total: number,
  rows: ReviewRowView[],
  extra: {
    offset: number;
    limit: number;
    nextOffset: number | null;
    complete: boolean;
    slice?: string;
    plan?: ReviewPlan;
    hint: string;
    next: string | null;
  },
): ReviewRowsPage {
  const patches = patchesOf(input, options, rows);
  return {
    prNumber: input.pack.prNumber,
    headSha: input.pack.headSha,
    total,
    offset: extra.offset,
    limit: extra.limit,
    nextOffset: extra.nextOffset,
    complete: extra.complete,
    ...(extra.slice === undefined ? {} : { slice: extra.slice }),
    ...(extra.plan === undefined ? {} : { plan: extra.plan }),
    counts: countsOf(input.pack),
    workspaces: workspaceBriefs(input.pack),
    rows,
    ...(patches === undefined ? {} : { patches }),
    commentsAvailable: input.threads.available,
    termsLoaded: input.terms !== null,
    next: extra.next,
    hint: extra.hint,
  };
}

/** 公开的 plan 只列开头几片；其余靠每片的 next 串起来，别让 plan 自己撑爆预算。 */
const PLAN_SLICES = 8;
const PLAN_CACHE = 8;

/** 边界按行索引记：同一份 pack 上重复读分片时不用重建整份 selection。 */
const planCache = new WeakMap<Pack, Map<string, { bytes: number; slices: PlannedSlice[] }>>();

function selectionKey(options: RowsOptions): string {
  const include = Object.entries(options.include)
    .filter(([, value]) => value)
    .map(([name]) => name)
    .join(",");
  return [
    options.filter,
    options.workspace ?? "",
    options.prefix ?? "",
    (options.keys ?? []).join(","),
    options.query ?? "",
    include,
  ].join("\u0000");
}

function planView(total: number, bytes: number, slices: readonly PlannedSlice[], fits: boolean): ReviewPlan {
  return {
    total,
    bytes,
    budgetBytes: ROWS_PAGE_BYTES,
    fits,
    sliceCount: slices.length,
    slices: slices.slice(0, PLAN_SLICES).map((slice) => ({
      id: slice.id,
      workspace: slice.workspace,
      rows: slice.rows,
      bytes: slice.bytes,
      firstKey: slice.firstKey,
      lastKey: slice.lastKey,
      uri: slice.uri,
    })),
  };
}

function planFor(input: RowsInput, options: RowsOptions, rows: readonly ReviewRowView[]): {
  plan: ReviewPlan;
  slices: PlannedSlice[];
} {
  const sizes = rows.map(rowBytes);
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (rows.length === 0 || totalBytes <= ROWS_PAGE_BYTES) {
    return { plan: planView(rows.length, totalBytes, [], true), slices: [] };
  }
  const slices: PlannedSlice[] = [];
  let index = 0;
  while (index < rows.length) {
    const workspace = rows[index]!.workspace;
    let end = index;
    let bytes = 0;
    let group = sliceGroup(rows[index]!.key);
    while (end < rows.length && rows[end]!.workspace === workspace && end - index < SLICE_MAX_ROWS) {
      const nextGroup = sliceGroup(rows[end]!.key);
      const size = sizes[end]!;
      if (end > index && bytes + size > ROWS_PAGE_BYTES && nextGroup !== group) break;
      bytes += size;
      group = nextGroup;
      end += 1;
    }
    const id = `${input.pack.headSha.slice(0, 7)}#${workspace}#${index}`;
    const uri = `pr://${input.pack.prNumber}/rows?${sliceParams(options, id).toString()}`;
    slices.push({
      id,
      workspace,
      rows: end - index,
      bytes,
      firstKey: rows[index]!.key,
      lastKey: rows[end - 1]!.key,
      uri,
      start: index,
      end,
    });
    index = end;
  }
  return { plan: planView(rows.length, totalBytes, slices, false), slices };
}

function cachePlan(pack: Pack, key: string, bytes: number, slices: PlannedSlice[]): void {
  const bucket = planCache.get(pack) ?? new Map<string, { bytes: number; slices: PlannedSlice[] }>();
  if (bucket.size >= PLAN_CACHE) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  bucket.set(key, { bytes, slices });
  planCache.set(pack, bucket);
}

function missingSlice(input: RowsInput, id: string): Error {
  return new Error(
    `分片不存在：${id}（plan 可能来自旧 head 或别的过滤条件）。重新 read pr://${input.pack.prNumber}?review=1 获取 plan，从 next 开始逐片读。`,
  );
}

/** 纯组装：预算内一次返回全量；超预算只返回 plan；带 slice 时返回完整分片。 */
export function reviewRowsForInput(input: RowsInput, options: RowsOptions): ReviewRowsResult {
  const selected = selectForOptions(input.pack, options);
  const key = selectionKey(options);
  let cached = planCache.get(input.pack)?.get(key);
  let built: ReviewRowView[] | undefined;
  if (cached === undefined) {
    built = buildRows(input, options, selected);
    const computed = planFor(input, options, built);
    if (computed.plan.fits) {
      if (options.slice !== undefined) throw missingSlice(input, options.slice);
      return {
        plan: computed.plan,
        page: basePage(input, options, selected.length, built, {
          offset: 0,
          limit: built.length,
          nextOffset: null,
          complete: true,
          hint: `全集 ${built.length} 行已一次返回，无需翻页。`,
          next: null,
        }),
      };
    }
    cachePlan(input.pack, key, computed.plan.bytes, computed.slices);
    cached = { bytes: computed.plan.bytes, slices: computed.slices };
  }
  const slices = cached.slices;
  const plan = planView(selected.length, cached.bytes, slices, false);
  if (options.slice === undefined) {
    return {
      plan,
      page: basePage(input, options, selected.length, [], {
        offset: 0,
        limit: 0,
        nextOffset: null,
        complete: false,
        plan,
        hint: `共 ${selected.length} 行 / ${plan.bytes} B，超过单页预算 ${plan.budgetBytes} B；照 next 逐片读，共 ${plan.sliceCount} 片。`,
        next: slices[0]?.uri ?? null,
      }),
    };
  }
  const index = slices.findIndex((entry) => entry.id === options.slice);
  const slice = index < 0 ? undefined : slices[index];
  if (slice === undefined) {
    throw missingSlice(input, options.slice);
  }
  const part =
    built === undefined
      ? buildRows(input, options, selected.slice(slice.start, slice.end))
      : built.slice(slice.start, slice.end);
  return {
    plan,
    page: basePage(input, options, selected.length, part, {
      offset: slice.start,
      limit: slice.rows,
      nextOffset: null,
      complete: true,
      slice: slice.id,
      hint: `分片 ${slice.id} 完整：第 ${index + 1}/${slices.length} 片，${part.length} 行（${slice.firstKey} … ${slice.lastKey}）。`,
      next: slices[index + 1]?.uri ?? null,
    }),
  };
}

/** 兼容人类分页与旧调用；agent 主流程走 reviewRowsForInput。 */
export function rowsPage(input: RowsInput, options: RowsOptions): ReviewRowsPage {
  const selected = selectForOptions(input.pack, options);
  const page = pageOf(options.offset, options.limit, 200, 100);
  const slice = selected.slice(page.offset, page.offset + page.limit);
  let rows = buildRows(input, options, slice);
  let bytes = 0;
  let kept = 0;
  for (const row of rows) {
    const size = rowBytes(row);
    if (kept > 0 && bytes + size > ROWS_PAGE_BYTES) break;
    bytes += size;
    kept += 1;
  }
  rows = rows.slice(0, kept);
  const nextOffset = page.offset + rows.length < selected.length ? page.offset + rows.length : null;
  const trimmed = rows.length < slice.length;
  return basePage(input, options, selected.length, rows, {
    offset: page.offset,
    limit: page.limit,
    nextOffset,
    complete: nextOffset === null,
    hint:
      nextOffset === null
        ? `本页 ${rows.length} 行，已取完 ${selected.length} 行。`
        : `本页 ${rows.length} 行${trimmed ? "（按体积截断）" : ""}，还剩 ${selected.length - page.offset - rows.length} 行；继续 read ${nextPageUri(`pr://${input.pack.prNumber}/rows`, pageParams(options), nextOffset)}`,
    next: nextPageUri(`pr://${input.pack.prNumber}/rows`, pageParams(options), nextOffset),
  });
}

export async function reviewRowsOf(n: number, options: RowsOptions): Promise<ReviewRowsResult> {
  const pack = await loadPack(n, options.rebuild === true);
  const threads = options.include.threads
    ? await threadsOf(n)
    : ({ available: false, headSha: null, pendingReviewId: null, threads: [] } satisfies ThreadsView);
  return reviewRowsForPack(n, pack, threads, options);
}

export async function rowsOf(n: number, options: RowsOptions): Promise<ReviewRowsPage> {
  return (await reviewRowsOf(n, options)).page;
}

/** 兼容 HTTP / 旧调用的 offset 分页；不参与 agent 主流程。 */
export async function rowsPageOf(n: number, options: RowsOptions): Promise<ReviewRowsPage> {
  const pack = await loadPack(n, options.rebuild === true);
  const threads = options.include.threads
    ? await threadsOf(n)
    : ({ available: false, headSha: null, pendingReviewId: null, threads: [] } satisfies ThreadsView);
  return rowsPageOfPack(n, pack, threads, options);
}

async function rowsPageOfPack(n: number, pack: Pack, threads: ThreadsView, options: RowsOptions): Promise<ReviewRowsPage> {
  const terms = options.include.terms ? await glossaryTerms() : null;
  const patches =
    options.include.patch
      ? new Map((await prdata.files(n)).files.map((file) => [file.path, file.patch]))
      : new Map<string, string | undefined>();
  return rowsPage({ pack, threads, terms, patches }, options);
}

/** 简报已经取过 pack 与线程时直接复用，避免同一轮再拉一次 GraphQL。 */
export async function reviewRowsForPack(
  n: number,
  pack: Pack,
  threads: ThreadsView,
  options: RowsOptions,
): Promise<ReviewRowsResult> {
  const terms = options.include.terms ? await glossaryTerms() : null;
  const patches =
    options.include.patch
      ? new Map((await prdata.files(n)).files.map((file) => [file.path, file.patch]))
      : new Map<string, string | undefined>();
  return reviewRowsForInput({ pack, threads, terms, patches }, options);
}
