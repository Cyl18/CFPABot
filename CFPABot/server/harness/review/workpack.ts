import { Buffer } from "node:buffer";
import type { Finding, ReviewHunk, ReviewRowView, SpecialPairContent } from "@cfpa/contracts/api";
import { MQM_TYPES } from "@cfpa/contracts/mqm";
import { workspaceKey, type Pack } from "@cfpa/review-core/pack";
import { writeLocal } from "../../agent/local-store.ts";
import { glossaryTerms } from "../../domain/glossary.ts";
import { prdata } from "../../prdata.ts";
import { specialContents, specialPairs } from "../../views/special.ts";
import { loadPack } from "../pack.ts";
import { balanceSlices, reviewRowViews, type RowsInput, type RowsOptions } from "./rows.ts";
import { threadsOf } from "./threads.ts";

/** 一片文档的目标大小：子代理一次读完，不靠工具翻页。 */
const SLICE_BUDGET_BYTES = 48_000;
const SLICE_MAX_ROWS = 300;
/** 片头（规则 + MQM + 元信息）的预留字节，实际片头只会更小。 */
const SLICE_RESERVE_BYTES = 6_000;
const LIST_CAP = 200;
const THREAD_SNIPPET = 140;

export interface WorkPackSlice {
  id: string;
  doc: string;
  kind: "lang" | "manual";
  workspace: string;
  path: string;
  rows: number;
  bytes: number;
  firstKey: string;
  lastKey: string;
  /** 手册片的 pair 名 */
  pair?: string;
}

export interface WorkPackManifest {
  prNumber: number;
  headSha: string;
  generatedAt: string;
  dir: string;
  budgetBytes: number;
  counts: { reviewable: number; slices: number; manualPairs: number; docBytes: number };
  workspaces: {
    workspace: string;
    format: string;
    enPath: string | null;
    zhPath: string | null;
    counts: { total: number; changed: number; flagged: number };
  }[];
  slices: WorkPackSlice[];
  fileFindings: { path: string; findings: Finding[] }[];
  duplicates: { workspace: string; zh: string; keys: string[] }[];
  checks: { workspace: string; findings: Finding[] }[];
  excluded: { rows: number };
}

export interface WorkPackComposition {
  manifest: WorkPackManifest;
  files: { name: string; content: string }[];
}

const MQM_TABLE = MQM_TYPES.map((type) => `${type.id} ${type.label} ${type.severity} — ${type.rule}`).join("\n");

function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function findingLine(finding: Finding): string {
  return `${finding.code} ${finding.severity}: ${oneLine(finding.detail, 160)}`;
}

function threadLine(thread: NonNullable<ReviewRowView["threads"]>[number]): string {
  const state = [thread.resolved ? "resolved" : "open", thread.outdated ? "outdated" : ""].filter(Boolean).join(" ");
  const first = thread.comments[0];
  const said = first === undefined ? "" : ` @${first.author}: ${oneLine(first.body, THREAD_SNIPPET)}`;
  return `${thread.id} ${state}${said}`;
}

/** 相邻两条的译文，回填时不用自己找邻近 key。 */
function neighborIndex(pack: Pack): Map<string, { prev?: string; next?: string }> {
  const index = new Map<string, { prev?: string; next?: string }>();
  for (const workspace of pack.workspaces) {
    const where = workspaceKey(workspace);
    workspace.rows.forEach((row, position) => {
      const prev = workspace.rows[position - 1];
      const next = workspace.rows[position + 1];
      const near: { prev?: string; next?: string } = {};
      if (prev !== undefined) near.prev = `${prev.key} = ${prev.headZh ?? "(无译文)"}`;
      if (next !== undefined) near.next = `${next.key} = ${next.headZh ?? "(无译文)"}`;
      index.set(`${where}\u0000${row.key}`, near);
    });
  }
  return index;
}

/** 一行一条记录：字段固定、能省就省，子代理不用解析 JSON。 */
function rowBlock(row: ReviewRowView, near?: { prev?: string; next?: string }): string {
  const lines = [`### ${row.key}`, `line: ${row.line ?? ""}`, `en: ${row.en ?? ""}`, `zh: ${row.zh ?? ""}`];
  if (row.raw !== undefined) lines.push(`raw: ${row.raw}`);
  if (row.baseZh !== undefined && row.baseZh !== row.zh) lines.push(`base: ${row.baseZh}`);
  if (near?.prev !== undefined) lines.push(`prev: ${near.prev}`);
  if (near?.next !== undefined) lines.push(`next: ${near.next}`);
  for (const finding of row.findings) lines.push(`find: ${findingLine(finding)}`);
  for (const term of row.terms ?? []) {
    lines.push(`term: ${term.en} → ${term.zh}${term.ok ? " glossary✓" : ` glossary✗ ${term.reason ?? "与术语表不一致"}`}`);
  }
  for (const thread of row.threads ?? []) lines.push(`thread: ${threadLine(thread)}`);
  if (row.duplicate !== undefined) lines.push(`dup: ${row.duplicate.keys.join("、")}`);
  return lines.join("\n");
}

function rulesBlock(manual: boolean): string {
  const deliver = manual
    ? [
        "## 交付",
        "- 只回判错的段落，写进 comments[]；每条给 key（pair 名）、severity、mqm、body、suggestion。path 用片头的 zh 路径，line 用文本里的行号。",
        "- 拿不准的写进 uncertain[]：key + 一句明确的问题。确定的先照常报，不要因为拿不准就把整片放掉。",
        "- 没判错就给空数组，不硬凑。",
        "- body 只写原因，不写标题、原文、译文行；多个问题写成有序列表。",
        "- suggestion 只给这一行的中文，不带行号前缀。",
        "- 同一 pattern 只报一条，其余 key 进 covers。",
        "- suspected 为真时 severity 最高 minor。",
        "- 跨模组体例查 glossary：英文正向，中文候选加 inverse，多个词用 mcp__glossary_query_batch。",
      ]
    : [
        "## 交付",
        "- 只回判错的行，写进 comments[]；每条给 key、severity、mqm、body、suggestion。path 固定用上面的文件路径，line 用行块里的 line。",
        "- 拿不准的写进 uncertain[]：key + 一句明确的问题。确定的先照常报，不要因为拿不准就把整片放掉。",
        "- 没判错就给空数组，不硬凑。",
        "- body 只写原因，不写标题、原文、译文行；多个问题写成有序列表。",
        "- 只给 zhNew：新译文本身，不带引号、缩进、逗号；整行由服务端拼。en/zh 不用给。非 suspected 必给。",
        "- 同一 pattern 只报一条，其余 key 进 covers；本条 key 不进 covers。",
        "- suspected 为真时 severity 最高 minor。",
        "- 行上的 term 只命中原版术语；跨模组体例查 glossary：英文正向，中文候选加 inverse，多个词用 mcp__glossary_query_batch。",
      ];
  return [
    ...deliver,
    "",
    "## MQM（只能用这些 id）",
    MQM_TABLE,
    "",
    "## 判定",
    "- critical：崩溃、反义、与既有译名撞车。major：错义、漏译、关键术语。minor：体例、标点、风格。neutral：灰区。",
    "- 行上的 find（如果有）是机械线索，不是结论；成立才报。",
    "- 一致性不是正确性；上游英文自己错的用 source/defect + neutral。",
    "- 看不懂的梗放行，不判。",
  ].join("\n");
}

function langHeader(slice: {
  id: string;
  prNumber: number;
  headSha: string;
  workspace: string;
  path: string;
  rows: number;
  firstKey: string;
  lastKey: string;
}): string {
  return [
    `# 审查分片 ${slice.id}`,
    `PR #${slice.prNumber} · head ${slice.headSha.slice(0, 7)} · workspace ${slice.workspace}`,
    `文件：${slice.path}`,
    `本片 ${slice.rows} 行，key 范围 ${slice.firstKey} … ${slice.lastKey}。只判本片，片外的事不要猜。`,
    "",
    rulesBlock(false),
    "",
    "## 行",
    "",
  ].join("\n");
}

function numbered(text: string): string {
  return text
    .split("\n")
    .map((line, index) => `${index + 1}| ${line}`)
    .join("\n");
}

function hunkText(label: string, hunks: readonly ReviewHunk[] | null): string {
  if (hunks === null || hunks.length === 0) return `${label}：未取到变更行`;
  return `${label}：${hunks.map((hunk) => `${hunk.start}-${hunk.end}`).join("、")}`;
}

function manualHeader(meta: {
  id: string;
  prNumber: number;
  headSha: string;
  pair: string;
  enPath: string;
  zhPath: string;
  enHunks: string;
  zhHunks: string;
  truncated: string;
}): string {
  return [
    `# 审查分片 ${meta.id}（手册）`,
    `PR #${meta.prNumber} · head ${meta.headSha.slice(0, 7)}`,
    `pair: ${meta.pair}`,
    `en：${meta.enPath}`,
    `zh：${meta.zhPath}`,
    meta.enHunks,
    meta.zhHunks,
    "两侧文本按 head 全文给出，行号写成 `n| 内容`。只判 zh 侧译文；没出现的行不要判。",
    ...(meta.truncated === "" ? [] : [`截断：${meta.truncated} 只给了前 12 KB。`]),
    "",
    rulesBlock(true),
    "",
    "--- en ---",
    "",
  ].join("\n");
}

interface SliceDraft {
  id: string;
  workspace: string;
  path: string;
  rows: ReviewRowView[];
}

function chunk(
  rows: readonly ReviewRowView[],
  headSha: string,
  budget: number,
  near: Map<string, { prev?: string; next?: string }>,
): SliceDraft[] {
  const drafts: SliceDraft[] = [];
  const cap = Math.max(1, budget - SLICE_RESERVE_BYTES);
  let index = 0;
  while (index < rows.length) {
    const first = rows[index]!;
    const path = first.path ?? "";
    let end = index;
    while (end < rows.length && rows[end]!.workspace === first.workspace && (rows[end]!.path ?? "") === path) {
      end += 1;
    }
    const segment = rows.slice(index, end);
    const sizes = segment.map(
      (row) => Buffer.byteLength(rowBlock(row, near.get(`${row.workspace}\u0000${row.key}`))) + 2,
    );
    for (const bound of balanceSlices(sizes, cap, SLICE_MAX_ROWS)) {
      drafts.push({
        id: "",
        workspace: first.workspace,
        path,
        rows: segment.slice(bound.start, bound.end),
      });
    }
    index = end;
  }
  for (const [position, draft] of drafts.entries()) {
    draft.id = `${headSha.slice(0, 7)}-${String(position + 1).padStart(2, "0")}`;
  }
  return drafts;
}

/** 打包只做组装：输入是完整的行视图，输出是 manifest 与待落盘的片文档。 */
export function composeWorkPack(
  pack: Pack,
  rows: readonly ReviewRowView[],
  now = new Date(),
  budget = SLICE_BUDGET_BYTES,
): WorkPackComposition {
  const reviewable = rows.filter((row) => row.path !== null && row.line !== null);
  const near = neighborIndex(pack);
  const drafts = chunk(reviewable, pack.headSha, budget, near);
  const files: WorkPackComposition["files"] = [];
  const slices: WorkPackSlice[] = [];
  let docBytes = 0;
  for (const draft of drafts) {
    const content = [
      langHeader({
        id: draft.id,
        prNumber: pack.prNumber,
        headSha: pack.headSha,
        workspace: draft.workspace,
        path: draft.path,
        rows: draft.rows.length,
        firstKey: draft.rows[0]?.key ?? "",
        lastKey: draft.rows[draft.rows.length - 1]?.key ?? "",
      }),
      draft.rows.map((row) => rowBlock(row, near.get(`${row.workspace}\u0000${row.key}`))).join("\n\n"),
      "",
    ].join("\n");
    const bytes = Buffer.byteLength(content);
    docBytes += bytes;
    const name = `pack/${pack.headSha.slice(0, 7)}/slices/${draft.id}.md`;
    files.push({ name, content });
    slices.push({
      id: draft.id,
      doc: `local://${name}`,
      kind: "lang",
      workspace: draft.workspace,
      path: draft.path,
      rows: draft.rows.length,
      bytes,
      firstKey: draft.rows[0]?.key ?? "",
      lastKey: draft.rows[draft.rows.length - 1]?.key ?? "",
    });
  }
  const manifest: WorkPackManifest = {
    prNumber: pack.prNumber,
    headSha: pack.headSha,
    generatedAt: now.toISOString(),
    dir: `pack/${pack.headSha.slice(0, 7)}`,
    budgetBytes: budget,
    counts: { reviewable: reviewable.length, slices: slices.length, manualPairs: 0, docBytes },
    workspaces: pack.workspaces.map((workspace) => ({
      workspace: workspaceKey(workspace),
      format: workspace.format,
      enPath: workspace.enPath,
      zhPath: workspace.zhPath,
      counts: workspace.counts,
    })),
    slices,
    fileFindings: pack.workspaces
      .flatMap((workspace) => workspace.fileFindings)
      .slice(0, LIST_CAP)
      .map((entry) => ({ path: entry.path, findings: entry.findings.slice(0, 5) })),
    duplicates: pack.workspaces
      .flatMap((workspace) =>
        workspace.duplicates.map((entry) => ({ workspace: workspaceKey(workspace), zh: entry.zh, keys: entry.keys })),
      )
      .slice(0, LIST_CAP),
    checks: pack.workspaces
      .filter((workspace) => workspace.checks.length > 0)
      .map((workspace) => ({ workspace: workspaceKey(workspace), findings: workspace.checks.slice(0, 10) })),
    excluded: { rows: rows.length - reviewable.length },
  };
  return { manifest, files };
}

export interface ManualSlices {
  files: { name: string; content: string }[];
  slices: WorkPackSlice[];
  docBytes: number;
}

/** 手册类 PR：一对 en/zh 一片，两侧全文带行号，子代理照行号判。 */
export function composeManualSlices(
  prNumber: number,
  headSha: string,
  items: readonly SpecialPairContent[],
): ManualSlices {
  const files: ManualSlices["files"] = [];
  const slices: WorkPackSlice[] = [];
  let docBytes = 0;
  let index = 0;
  for (const item of items) {
    if (item.kind !== "pair" || item.zh.head === null) continue;
    index += 1;
    const id = `${headSha.slice(0, 7)}-m${String(index).padStart(2, "0")}`;
    const truncated = [item.en.truncated ? "en" : "", item.zh.truncated ? "zh" : ""].filter(Boolean).join("、");
    const content = [
      manualHeader({
        id,
        prNumber,
        headSha,
        pair: item.key,
        enPath: item.en.path,
        zhPath: item.zh.path,
        enHunks: hunkText("变更行（en）", item.en.hunks),
        zhHunks: hunkText("变更行（zh）", item.zh.hunks),
        truncated,
      }),
      numbered(item.en.head ?? ""),
      "",
      "--- zh ---",
      "",
      numbered(item.zh.head),
      "",
    ].join("\n");
    const bytes = Buffer.byteLength(content);
    docBytes += bytes;
    const name = `pack/${headSha.slice(0, 7)}/slices/${id}.md`;
    files.push({ name, content });
    slices.push({
      id,
      doc: `local://${name}`,
      kind: "manual",
      workspace: "manual",
      path: item.zh.path,
      rows: 0,
      bytes,
      firstKey: item.key,
      lastKey: item.key,
      pair: item.key,
    });
  }
  return { files, slices, docBytes };
}

/** 手册片并进同一份包；没有手册就不产生额外读取。 */
export async function withManualSlices(
  n: number,
  headSha: string,
  composed: WorkPackComposition,
): Promise<WorkPackComposition> {
  const pairs = await specialPairs(n);
  const keys = pairs.filter((entry) => entry.kind === "pair").map((entry) => entry.key);
  if (keys.length === 0) return composed;
  const manual = composeManualSlices(n, headSha, await specialContents(n, keys, prdata.fileSource()));
  composed.files.push(...manual.files);
  composed.manifest.slices.push(...manual.slices);
  composed.manifest.counts.slices = composed.manifest.slices.length;
  composed.manifest.counts.manualPairs = manual.slices.length;
  composed.manifest.counts.docBytes += manual.docBytes;
  return composed;
}

/** 片文档先落盘，manifest 最后写：manifest 存在才视为整包可用。 */
export async function persistWorkPack(sessionId: string, composed: WorkPackComposition): Promise<void> {
  for (const file of composed.files) await writeLocal(sessionId, file.name, file.content);
  await writeLocal(sessionId, "pack/manifest.json", `${JSON.stringify(composed.manifest, null, 2)}\n`);
}

/** 主代理一条命令拿到整包：文件落到会话 workspace，返回值只有 manifest。 */
export async function writeWorkPack(n: number, sessionId: string): Promise<WorkPackManifest> {
  const pack = await loadPack(n);
  const [threads, terms] = await Promise.all([threadsOf(n, pack.headSha), glossaryTerms()]);
  const input: RowsInput = { pack, threads, terms, patches: new Map() };
  const options: RowsOptions = {
    filter: "reviewable",
    include: { terms: true, threads: true, duplicates: true, patch: false },
  };
  const composed = await withManualSlices(n, pack.headSha, composeWorkPack(pack, reviewRowViews(input, options)));
  await persistWorkPack(sessionId, composed);
  return composed.manifest;
}
