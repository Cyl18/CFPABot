import type {
  ReviewPlan,
  ReviewRowView,
  ReviewRowsPage,
  ReviewSlice,
  ReviewThread,
  WorkspaceBrief,
} from "@cfpa/contracts/api";
import { matchTerms, type TermIndex } from "@cfpa/review-core/domain/terms";
import { selectRows, workspaceBrief, workspaceKey, type Pack, type PackWorkspace } from "@cfpa/review-core/pack";
import type { SelectedRow } from "@cfpa/review-core/pack";
import { glossaryTerms } from "../../domain/glossary.ts";
import { prdata } from "../../prdata.ts";
import { RESULT_BUDGET_BYTES } from "../result.ts";
import { loadPack } from "../pack.ts";
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

const briefCache = new WeakMap<Pack, WorkspaceBrief[]>();

function packBriefs(pack: Pack): WorkspaceBrief[] {
  let briefs = briefCache.get(pack);
  if (briefs === undefined) {
    briefs = workspaceBriefs(pack);
    briefCache.set(pack, briefs);
  }
  return briefs;
}

export function workspaceBriefs(pack: Pack): WorkspaceBrief[] {
  return pack.workspaces.map(workspaceBrief);
}

function reviewableCount(pack: Pack): number {
  let count = 0;
  for (const workspace of pack.workspaces) {
    for (const row of workspace.rows) if (row.changed && row.inHunk) count += 1;
  }
  return count;
}

function threadIndexes(
  pack: Pack,
  threads: readonly ReviewThread[],
): { byLocation: Map<string, ReviewThread[]>; byKey: Map<string, ReviewThread[]> } {
  const rowKey = new Map<string, string>();
  for (const workspace of pack.workspaces) {
    for (const row of workspace.rows) {
      if (row.line === null) continue;
      for (const path of [workspace.zhPath, workspace.enPath]) {
        if (path !== null) rowKey.set(`${path}\u0000${row.line}`, row.key);
      }
    }
  }
  const byLocation = new Map<string, ReviewThread[]>();
  const byKey = new Map<string, ReviewThread[]>();
  const push = (map: Map<string, ReviewThread[]>, key: string, thread: ReviewThread): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [thread]);
    else if (!list.includes(thread)) list.push(thread);
  };
  for (const thread of threads) {
    const lines = [thread.line, thread.originalLine].filter((line): line is number => line !== null);
    const keys = new Set<string>();
    for (const line of lines) {
      const at = `${thread.path}\u0000${line}`;
      push(byLocation, at, thread);
      const key = rowKey.get(at);
      if (key !== undefined && !keys.has(key)) {
        keys.add(key);
        push(byKey, key, thread);
      }
    }
  }
  return { byLocation, byKey };
}

/** 同 key 的另一版本只传播已 resolved 的裁定：未解决的评论换个文件没有意义。 */
function mergeThreads(here: readonly ReviewThread[] | undefined, shared: readonly ReviewThread[] | undefined): ReviewThread[] {
  const out: ReviewThread[] = [];
  const seen = new Set<string>();
  for (const thread of here ?? []) {
    seen.add(thread.id);
    out.push(thread);
  }
  for (const thread of shared ?? []) {
    if (!thread.resolved || seen.has(thread.id)) continue;
    seen.add(thread.id);
    out.push(thread);
  }
  return out;
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

export interface SliceBounds {
  start: number;
  end: number;
  bytes: number;
}

/** 先按总字节定片数，再按行数均分；单行超预算时独占一片。 */
export function balanceSlices(
  sizes: readonly number[],
  budget: number,
  maxRows: number,
): SliceBounds[] {
  const count = sizes.length;
  if (count === 0) return [];
  const cap = Math.max(1, budget);
  const rowCap = Math.max(1, maxRows);
  const prefix = new Array<number>(count + 1).fill(0);
  for (let index = 0; index < count; index += 1) prefix[index + 1] = prefix[index]! + sizes[index]!;
  const total = prefix[count]!;
  let plan = Math.min(count, Math.max(1, Math.ceil(total / cap), Math.ceil(count / rowCap)));
  for (;;) {
    const bounds: SliceBounds[] = [];
    let start = 0;
    let complete = true;
    for (let index = 0; index < plan; index += 1) {
      const left = plan - index;
      const remaining = count - start;
      if (remaining < left) {
        complete = false;
        break;
      }
      let end = start + Math.min(Math.ceil(remaining / left), rowCap);
      let bytes = prefix[end]! - prefix[start]!;
      while (end > start + 1 && bytes > cap) {
        end -= 1;
        bytes -= sizes[end]!;
      }
      bounds.push({ start, end, bytes });
      start = end;
    }
    if (complete && start === count) return mergeTinyTail(bounds, cap, rowCap, total);
    plan += 1;
  }
}

/** 尾片小于平均片一半且并得进去时并入前片，别留孤儿片。 */
function mergeTinyTail(
  bounds: SliceBounds[],
  cap: number,
  maxRows: number,
  total: number,
): SliceBounds[] {
  while (bounds.length > 1) {
    const last = bounds[bounds.length - 1]!;
    const prev = bounds[bounds.length - 2]!;
    if (last.bytes * 2 >= total / bounds.length) break;
    if (last.end - last.start + (prev.end - prev.start) > maxRows) break;
    if (prev.bytes + last.bytes > cap) break;
    prev.end = last.end;
    prev.bytes += last.bytes;
    bounds.pop();
  }
  return bounds;
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

export function rowsUri(n: number, options: RowsOptions): string {
  return `pr://${n}/rows?${filterParams(options).toString()}`;
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
  const indexes = input.threads.available
    ? threadIndexes(input.pack, input.threads.threads)
    : { byLocation: new Map<string, ReviewThread[]>(), byKey: new Map<string, ReviewThread[]>() };
  return selected.map(({ workspace, row }: SelectedRow) => {
    const path = workspace.zhPath;
    const here = path === null ? undefined : indexes.byLocation.get(`${path}\u0000${row.line ?? -1}`);
    const found = mergeThreads(here, indexes.byKey.get(row.key));
    const duplicate = options.include.duplicates ? duplicateOf(workspace, row.key, row.headZh) : undefined;
    return {
      workspace: workspaceKey(workspace),
      path,
      key: row.key,
      ...(row.headEn === undefined ? {} : { en: row.headEn }),
      ...(row.headZh === undefined ? {} : { zh: row.headZh }),
      ...(row.baseEn === undefined ? {} : { baseEn: row.baseEn }),
      ...(row.baseZh === undefined ? {} : { baseZh: row.baseZh }),
      ...(row.headRaw === undefined ? {} : { raw: row.headRaw }),
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
      ...(options.include.threads && found.length > 0 ? { threads: found } : {}),
      ...(duplicate === undefined ? {} : { duplicate }),
    };
  });
}

function patchesOf(
  input: RowsInput,
  options: RowsOptions,
  rows: readonly ReviewRowView[],
): { patches?: Record<string, string>; omitted?: string[] } {
  if (!options.include.patch) return {};
  const patches: Record<string, string> = {};
  const omitted: string[] = [];
  let bytes = 0;
  for (const path of new Set(rows.map((row) => row.path).filter((path): path is string => path !== null))) {
    const patch = input.patches.get(path);
    if (patch === undefined || patch === "") continue;
    const size = Buffer.byteLength(JSON.stringify(patch));
    // 超大 patch 不内联
    if (size > PATCH_BUDGET_BYTES || (bytes > 0 && bytes + size > PATCH_BUDGET_BYTES)) {
      omitted.push(path);
      continue;
    }
    patches[path] = patch;
    bytes += size;
  }
  return {
    ...(Object.keys(patches).length === 0 ? {} : { patches }),
    ...(omitted.length === 0 ? {} : { omitted }),
  };
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
    /** 分片页不带工作区清单 */
    withWorkspaces?: boolean;
  },
): ReviewRowsPage {
  const patchView = patchesOf(input, options, rows);
  const workspaceList = extra.withWorkspaces !== false && input.pack.workspaces.length <= MAX_PAGE_WORKSPACES;
  const filtered =
    options.workspace !== undefined ||
    options.prefix !== undefined ||
    options.keys !== undefined ||
    options.query !== undefined ||
    options.filter !== "all";
  const scopeHint = filtered ? " counts 为整份 pack，total 为当前过滤结果。" : "";
  const zeroHint =
    input.pack.counts.changed > 0 && reviewableCount(input.pack) === 0
      ? " changed 行不在 zh diff hunk 内，reviewable 为 0。"
      : "";
  const truncHint = input.pack.workspacesTruncated
    ? ` 预审只覆盖前 ${input.pack.workspaces.length} 个工作区。`
    : "";
  const hint = workspaceList || extra.withWorkspaces === false
    ? `${extra.hint}${scopeHint}${zeroHint}${truncHint}`
    : `${extra.hint}${scopeHint}${zeroHint}${truncHint} 工作区清单超过 ${MAX_PAGE_WORKSPACES} 个已省略。`;
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
    ...(workspaceList ? { workspaces: packBriefs(input.pack) } : {}),
    rows,
    ...(patchView.patches === undefined ? {} : { patches: patchView.patches }),
    ...(patchView.omitted === undefined ? {} : { patchesOmitted: patchView.omitted }),
    commentsAvailable: input.threads.available,
    termsLoaded: input.terms !== null,
    next: extra.next,
    hint,
  };
}

/** 公开的 plan 只列开头几片；其余靠每片的 next 串起来，别让 plan 自己撑爆预算。 */
const PLAN_SLICES = 8;
const PLAN_CACHE = 8;
const PLAN_RESERVE_BYTES = 4_000;
const PATCH_BUDGET_BYTES = 8_000;
const BUDGET_MARGIN_BYTES = 1_500;
const MIN_ROWS_BUDGET_BYTES = 2_000;
const MAX_PAGE_WORKSPACES = 80;

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

function planView(total: number, bytes: number, slices: readonly PlannedSlice[], fits: boolean, budget: number): ReviewPlan {
  return {
    total,
    bytes,
    budgetBytes: budget,
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

function pageSkeletonBytes(input: RowsInput): number {
  return Buffer.byteLength(
    JSON.stringify({
      prNumber: input.pack.prNumber,
      headSha: input.pack.headSha,
      total: 0,
      offset: 0,
      limit: 0,
      nextOffset: null,
      complete: false,
      counts: { workspaces: 0, rows: 0, changed: 0, flagged: 0, reviewable: 0 },
      rows: [],
      commentsAvailable: input.threads.available,
      termsLoaded: input.terms !== null,
      next: null,
      hint: "",
    }),
  );
}

/** 预算按整页 JSON 取全集页与分片页的较大开销 */
function rowsBudget(input: RowsInput, options: RowsOptions): number {
  const base = pageSkeletonBytes(input);
  const workspaceBytes =
    input.pack.workspaces.length <= MAX_PAGE_WORKSPACES
      ? Buffer.byteLength(JSON.stringify(packBriefs(input.pack)))
      : 0;
  const patchReserve = options.include.patch ? PATCH_BUDGET_BYTES : 0;
  return Math.max(
    MIN_ROWS_BUDGET_BYTES,
    Math.min(40_000, RESULT_BUDGET_BYTES - Math.max(base + workspaceBytes, base + PLAN_RESERVE_BYTES) - patchReserve - BUDGET_MARGIN_BYTES),
  );
}

function shortHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function planFor(input: RowsInput, options: RowsOptions, rows: readonly ReviewRowView[], budget: number, seed: string): {
  plan: ReviewPlan;
  slices: PlannedSlice[];
} {
  const sizes = rows.map(rowBytes);
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (rows.length === 0 || totalBytes <= budget) {
    return { plan: planView(rows.length, totalBytes, [], true, budget), slices: [] };
  }
  const slices: PlannedSlice[] = [];
  let index = 0;
  while (index < rows.length) {
    const workspace = rows[index]!.workspace;
    let end = index;
    while (end < rows.length && rows[end]!.workspace === workspace) end += 1;
    for (const bound of balanceSlices(sizes.slice(index, end), budget, SLICE_MAX_ROWS)) {
      const start = index + bound.start;
      const stop = index + bound.end;
      const id = `${input.pack.headSha.slice(0, 7)}~${shortHash(`${seed}\u0000${budget}`)}~${workspace}~${start}`;
      const uri = `pr://${input.pack.prNumber}/rows?${sliceParams(options, id).toString()}`;
      slices.push({
        id,
        workspace,
        rows: stop - start,
        bytes: bound.bytes,
        firstKey: rows[start]!.key,
        lastKey: rows[stop - 1]!.key,
        uri,
        start,
        end: stop,
      });
    }
    index = end;
  }
  return { plan: planView(rows.length, totalBytes, slices, false, budget), slices };
}

function cachePlan(pack: Pack, key: string, bytes: number, slices: PlannedSlice[]): void {
  const bucket = planCache.get(pack) ?? new Map<string, { bytes: number; slices: PlannedSlice[] }>();
  bucket.delete(key);
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

/** 打包用：一次给出全部选中的行视图，不走分页预算。 */
export function reviewRowViews(input: RowsInput, options: RowsOptions): ReviewRowView[] {
  return buildRows(input, options, selectForOptions(input.pack, options));
}

/** 纯组装：预算内一次返回全量；超预算只返回 plan；带 slice 时返回完整分片。 */
export function reviewRowsForInput(input: RowsInput, options: RowsOptions): ReviewRowsResult {
  const selected = selectForOptions(input.pack, options);
  const budget = rowsBudget(input, options);
  const key = selectionKey(options);
  let cached = planCache.get(input.pack)?.get(key);
  if (cached !== undefined) {
    const bucket = planCache.get(input.pack);
    bucket?.delete(key);
    bucket?.set(key, cached);
  }
  let built: ReviewRowView[] | undefined;
  if (cached === undefined) {
    built = buildRows(input, options, selected);
    const computed = planFor(input, options, built, budget, key);
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
  const cachedPlan = cached;
  const slices = cachedPlan.slices;
  const plan = planView(selected.length, cachedPlan.bytes, slices, false, budget);
  if (options.slice === undefined) {
    return {
      plan,
      page: basePage(input, options, selected.length, [], {
        offset: 0,
        limit: 0,
        nextOffset: null,
        complete: false,
        plan,
        hint: `共 ${selected.length} 行 / ${plan.bytes} B，超过单页预算 ${plan.budgetBytes} B；要派单先 write pr://${input.pack.prNumber}/pack {}，或照 next 逐片读，共 ${plan.sliceCount} 片。`,
        next: slices[0]?.uri ?? null,
      }),
    };
  }
  const index = slices.findIndex((entry) => entry.id === options.slice);
  const slice = index < 0 ? undefined : slices[index];
  if (
    slice === undefined ||
    selected[slice.start]?.row.key !== slice.firstKey ||
    selected[slice.end - 1]?.row.key !== slice.lastKey
  ) {
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
      withWorkspaces: false,
      hint: `分片 ${slice.id} 完整：第 ${index + 1}/${slices.length} 片，${part.length} 行（${slice.firstKey} … ${slice.lastKey}）。`,
      next: slices[index + 1]?.uri ?? null,
    }),
  };
}

/** Agent 主流程：加载 pack 与线程后走统一预算协议。 */
export async function reviewRowsOf(n: number, options: RowsOptions): Promise<ReviewRowsResult> {
  const pack = await loadPack(n, options.rebuild === true);
  const threads = options.include.threads
    ? await threadsOf(n, pack.headSha)
    : ({ available: false, headSha: null, pendingReviewId: null, threads: [] } satisfies ThreadsView);
  return reviewRowsForPack(n, pack, threads, options);
}

export async function rowsOf(n: number, options: RowsOptions): Promise<ReviewRowsPage> {
  return (await reviewRowsOf(n, options)).page;
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
