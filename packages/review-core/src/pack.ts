import type { Severity, Workspace } from "@cfpa/contracts/api";
import { entryFindings, duplicateZh, fileFindings } from "./domain/checks.ts";
import { inHunks, patchHunks } from "./domain/diff.ts";
import { parseLang, type ParsedLang } from "./domain/langfile.ts";
import { parseLangPath, langPathFor, workspacesOf, type LangFormat, type Locale } from "./domain/path.ts";
import { matchQa, matchTerms, type TermIndex } from "./domain/terms.ts";
import type { PackFile } from "./types.ts";

export interface PackFinding {
  source: "program" | "term" | "qa";
  code: string;
  severity: Severity;
  detail: string;
}

export interface PackRow {
  key: string;
  baseEn?: string;
  headEn?: string;
  baseZh?: string;
  headZh?: string;
  line: number | null;
  inHunk: boolean;
  changed: boolean;
  findings: PackFinding[];
}

export interface PackWorkspace {
  slug: string;
  version: string;
  namespace: string;
  format: LangFormat;
  enPath: string | null;
  zhPath: string | null;
  rows: PackRow[];
  fileFindings: { path: string; findings: PackFinding[] }[];
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

function parseOrNull(content: string | null, format: LangFormat): ParsedLang | null {
  return content === null ? null : parseLang(content, format);
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

function findingsFor(
  key: string,
  values: { baseEn?: string; headEn?: string; baseZh?: string; headZh?: string },
  version: string,
  terms: TermIndex | null,
): PackFinding[] {
  const findings: PackFinding[] = [];
  for (const finding of entryFindings(key, values.headEn, values.headZh, { en: values.baseEn, zh: values.baseZh })) {
    findings.push({ source: "program", code: finding.code, severity: finding.hint, detail: finding.detail });
  }
  if (!terms || values.headEn === undefined) return findings;
  for (const hit of matchTerms(terms, key, values.headEn, values.headZh ?? "", version)) {
    if (hit.ok) continue;
    findings.push({
      source: "term",
      code: `term:${hit.en}`,
      severity: "major",
      detail: `${hit.en} → ${hit.zh.join(" / ")}${hit.reason ? `（${hit.reason}）` : ""}`,
    });
  }
  for (const hit of matchQa(terms, key, values.headEn, values.headZh ?? "")) {
    if (hit.ok) continue;
    findings.push({ source: "qa", code: `qa:${hit.id}`, severity: "minor", detail: hit.comment ?? hit.require ?? hit.id });
  }
  return findings;
}

async function buildWorkspace(
  workspace: Workspace,
  input: PackInput,
  patches: Map<string, string | undefined>,
): Promise<PackWorkspace | null> {
  let enPath: string | null = null;
  let zhPath: string | null = null;
  for (const file of workspace.files) {
    const parsed = parseLangPath(file);
    if (!parsed) continue;
    if (parsed.locale === "en_us") enPath ??= file;
    else if (parsed.locale === "zh_cn") zhPath ??= file;
  }
  if (enPath === null && zhPath !== null) enPath = langPathFor(zhPath, "en_us")[0] ?? null;
  if (zhPath === null && enPath !== null) zhPath = langPathFor(enPath, "zh_cn")[0] ?? null;
  const sample = parseLangPath(zhPath ?? enPath ?? "");
  if (!sample) return null;
  const format = sample.format;
  const statusOf = new Map(input.files.map((file) => [file.path, file.status]));
  const readSide = async (path: string | null, locale: Locale, ref: "base" | "head"): Promise<string | null> => {
    if (path === null) return null;
    const status = statusOf.get(path);
    if (ref === "base" ? status === "added" : status === "removed") return null;
    for (const candidate of langPathFor(path, locale)) {
      const text = await input.read(candidate, ref);
      if (text !== null) return text;
    }
    return null;
  };
  const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([
    readSide(enPath, "en_us", "base"),
    readSide(zhPath, "zh_cn", "base"),
    readSide(enPath, "en_us", "head"),
    readSide(zhPath, "zh_cn", "head"),
  ]);
  const baseEn = parseOrNull(baseEnText, format);
  const baseZh = parseOrNull(baseZhText, format);
  const headEn = parseOrNull(headEnText, format);
  const headZh = parseOrNull(headZhText, format);
  const patch = zhPath ? patches.get(zhPath) : undefined;
  const hunks = patch === undefined || patch === "" ? null : patchHunks(patch);
  const rows: PackRow[] = [];
  for (const key of keyOrder(headEn, [baseEn, baseZh, headZh])) {
    const values = {
      baseEn: baseEn?.entries.get(key),
      headEn: headEn?.entries.get(key),
      baseZh: baseZh?.entries.get(key),
      headZh: headZh?.entries.get(key),
    };
    const line = headZh?.lines.get(key) ?? null;
    rows.push({
      key,
      ...values,
      line,
      inHunk: line !== null && hunks !== null && inHunks(line, hunks),
      changed: values.baseEn !== values.headEn || values.baseZh !== values.headZh,
      findings: findingsFor(key, values, workspace.version, input.terms),
    });
  }
  const fileLevel: { path: string; findings: PackFinding[] }[] = [];
  for (const [path, content] of [
    [enPath, headEnText],
    [zhPath, headZhText],
  ] as [string | null, string | null][]) {
    if (!path || content === null) continue;
    fileLevel.push({
      path,
      findings: fileFindings(content).map((finding) => ({
        source: "program" as const,
        code: finding.code,
        severity: finding.hint,
        detail: finding.detail,
      })),
    });
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
  const workspaces = workspacesOf(input.files);
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
    counts: {
      workspaces: built.length,
      rows: built.reduce((sum, workspace) => sum + workspace.counts.total, 0),
      changed: built.reduce((sum, workspace) => sum + workspace.counts.changed, 0),
      flagged: built.reduce((sum, workspace) => sum + workspace.counts.flagged, 0),
    },
  };
}
