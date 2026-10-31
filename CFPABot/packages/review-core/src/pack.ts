import type { Finding, Workspace, WorkspaceBrief } from "@cfpa/contracts/api";
import { duplicateZh, fileFindings, keyParity } from "./domain/checks.ts";
import { inHunks, patchHunks } from "./domain/diff.ts";
import { entryFindingsWithTerms } from "./domain/entry-findings.ts";
import type { ParsedLang } from "./domain/langfile.ts";
import { workspacesOf, type LangFormat } from "./domain/path.ts";
import type { TermIndex } from "./domain/terms.ts";
import { loadWorkspaceTexts } from "./domain/workspace-files.ts";
import type { PackFile } from "./types.ts";

export interface PackRow {
  key: string;
  baseEn?: string;
  headEn?: string;
  baseZh?: string;
  headZh?: string;
  /** head 该行原文，只给 changed 行，用于整行 suggestion 对齐。 */
  headRaw?: string;
  line: number | null;
  inHunk: boolean;
  changed: boolean;
  findings: Finding[];
}

export interface PackWorkspace {
  slug: string;
  version: string;
  namespace: string;
  format: LangFormat;
  enPath: string | null;
  zhPath: string | null;
  rows: PackRow[];
  checks: Finding[];
  fileFindings: { path: string; findings: Finding[] }[];
  duplicates: { zh: string; keys: string[] }[];
  counts: { total: number; changed: number; flagged: number };
}

export interface Pack {
  prNumber: number;
  baseSha: string;
  headSha: string;
  generatedAt: string;
  workspaces: PackWorkspace[];
  counts: { workspaces: number; rows: number; changed: number; flagged: number };
  workspacesTruncated?: boolean;
}

export interface PackInput {
  prNumber: number;
  baseSha: string;
  headSha: string;
  files: PackFile[];
  read(path: string, ref: "base" | "head"): Promise<string | null>;
  terms: TermIndex | null;
}

const WORKSPACE_CONCURRENCY = 4;
/** 与 Bot 检查共用同一个上限，避免面板/Agent 对超大 PR 触发无界文件读取。 */
export const MAX_WORKSPACES = 40;

export function workspaceKey(workspace: Pick<PackWorkspace, "slug" | "version" | "namespace">): string {
  return `${workspace.slug}/${workspace.version}/${workspace.namespace}`;
}

export function findingHistogram(workspace: PackWorkspace): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const row of workspace.rows) {
    for (const finding of row.findings) histogram[finding.code] = (histogram[finding.code] ?? 0) + 1;
  }
  return histogram;
}

/** 共用工作区描述 */
export function workspaceBrief(workspace: PackWorkspace): Required<WorkspaceBrief> {
  return {
    workspace: workspaceKey(workspace),
    format: workspace.format,
    enPath: workspace.enPath,
    zhPath: workspace.zhPath,
    counts: workspace.counts,
    histogram: findingHistogram(workspace),
    duplicates: workspace.duplicates.length,
  };
}

export interface RowSelection {
  workspace?: string;
  keys?: string[];
  filter?: "changed" | "flagged" | "all";
  query?: string;
}

export interface SelectedRow {
  workspace: PackWorkspace;
  row: PackRow;
}

export function selectRows(pack: Pack, selection: RowSelection): SelectedRow[] {
  const wanted = selection.keys && selection.keys.length > 0 ? new Set(selection.keys) : null;
  const query = selection.query?.trim().toLowerCase();
  const filter = selection.filter ?? "all";
  const selected: SelectedRow[] = [];
  for (const workspace of pack.workspaces) {
    if (selection.workspace && workspaceKey(workspace) !== selection.workspace) continue;
    for (const row of workspace.rows) {
      if (wanted && !wanted.has(row.key)) continue;
      if (filter === "changed" && !row.changed) continue;
      if (filter === "flagged" && row.findings.length === 0) continue;
      if (query && !matchesQuery(row, query)) continue;
      selected.push({ workspace, row });
    }
  }
  return selected;
}

function matchesQuery(row: PackRow, query: string): boolean {
  return [row.key, row.headEn, row.headZh, row.baseEn, row.baseZh].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(query),
  );
}

function keyOrder(head: ParsedLang | null, others: (ParsedLang | null)[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  if (head) {
    for (const key of head.entries.keys()) {
      seen.add(key);
      order.push(key);
    }
  }
  const rest = new Set<string>();
  for (const parsed of others) {
    if (!parsed) continue;
    for (const key of parsed.entries.keys()) if (!seen.has(key)) rest.add(key);
  }
  return [...order, ...[...rest].sort()];
}

async function buildWorkspace(
  workspace: Workspace,
  input: PackInput,
  patches: Map<string, string | undefined>,
): Promise<PackWorkspace | null> {
  const loaded = await loadWorkspaceTexts(workspace, input.files, input.read);
  if (loaded === null) return null;
  const { format, enPath, zhPath, baseEn, baseZh, headEn, headZh, headEnText, headZhText } = loaded;
  const patch = zhPath ? patches.get(zhPath) : undefined;
  const hunks = patch === undefined || patch === "" ? null : patchHunks(patch);
  const zhLines = headZhText === null ? null : headZhText.split("\n");
  const rows: PackRow[] = [];
  for (const key of keyOrder(headEn, [baseEn, baseZh, headZh])) {
    const values = {
      baseEn: baseEn?.entries.get(key),
      headEn: headEn?.entries.get(key),
      baseZh: baseZh?.entries.get(key),
      headZh: headZh?.entries.get(key),
    };
    const line = headZh?.lines.get(key) ?? null;
    const changed = values.baseEn !== values.headEn || values.baseZh !== values.headZh;
    const headRaw =
      changed && line !== null && zhLines !== null ? (zhLines[line - 1] ?? "").replace(/\r$/, "") : undefined;
    rows.push({
      key,
      ...values,
      ...(headRaw === undefined ? {} : { headRaw }),
      line,
      inHunk: line !== null && hunks !== null && inHunks(line, hunks),
      changed,
      findings: entryFindingsWithTerms(key, values, workspace.version, input.terms),
    });
  }
  const checks = keyParity(workspaceKey(workspace), headEn, headZh);
  const fileLevel: { path: string; findings: Finding[] }[] = [];
  for (const [path, content] of [
    [enPath, headEnText],
    [zhPath, headZhText],
  ] as [string | null, string | null][]) {
    if (!path || content === null) continue;
    fileLevel.push({ path, findings: fileFindings(path, content) });
  }
  const duplicates = [...duplicateZh(rows.map((row) => ({ key: row.key, en: row.headEn, zh: row.headZh })))].map(
    ([zh, keys]) => ({ zh, keys }),
  );
  return {
    slug: workspace.slug,
    version: workspace.version,
    namespace: workspace.namespace,
    format,
    enPath,
    zhPath,
    rows,
    checks,
    fileFindings: fileLevel,
    duplicates,
    counts: {
      total: rows.length,
      changed: rows.filter((row) => row.changed).length,
      flagged: rows.filter((row) => row.findings.length > 0).length,
    },
  };
}

export async function buildPack(input: PackInput): Promise<Pack> {
  const patches = new Map<string, string | undefined>();
  for (const file of input.files) patches.set(file.path, file.patch);
  const available = workspacesOf(input.files);
  const workspaces = available.slice(0, MAX_WORKSPACES);
  const built: PackWorkspace[] = [];
  for (let index = 0; index < workspaces.length; index += WORKSPACE_CONCURRENCY) {
    const batch = workspaces.slice(index, index + WORKSPACE_CONCURRENCY);
    const results = await Promise.all(batch.map((workspace) => buildWorkspace(workspace, input, patches)));
    for (const result of results) if (result) built.push(result);
  }
  return {
    prNumber: input.prNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    generatedAt: new Date().toISOString(),
    workspaces: built,
    ...(available.length > workspaces.length ? { workspacesTruncated: true } : {}),
    counts: {
      workspaces: built.length,
      rows: built.reduce((sum, workspace) => sum + workspace.counts.total, 0),
      changed: built.reduce((sum, workspace) => sum + workspace.counts.changed, 0),
      flagged: built.reduce((sum, workspace) => sum + workspace.counts.flagged, 0),
    },
  };
}
