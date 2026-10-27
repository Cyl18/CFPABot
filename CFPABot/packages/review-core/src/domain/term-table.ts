import type { TermCandidate, TermEntry, TermTable, TermVariant } from "@cfpa/contracts/api";
import type { Pack } from "../pack.ts";
import { lookupTerm, type TermIndex } from "./terms.ts";

/** 注册名类 key：这些条目本身就是物品/方块/实体的显示名，值得单独定术语。 */
const REGISTRATION = /^(item|block|fluid|entity|effect|enchantment|biome|tile|itemGroup|item_group|painting|trim_pattern|trim_material|instrument)\./;
const MAX_TOKENS = 6;
const MAX_EN_CHARS = 48;
const MAX_KEYS = 30;
const PLACEHOLDER = /[%{}<>\\$\\]/;

export interface CandidateOptions {
  /** 非注册名 key 至少重复几次才进候选。 */
  minCount?: number;
  /** 每个候选带几条全文上下文。 */
  contexts?: number;
  limit?: number;
}

interface Draft {
  en: string;
  count: number;
  registration: boolean;
  variants: Map<string, string[]>;
  contexts: TermCandidate["contexts"];
}

/** 长句、带占位符的值不是术语；判据只看形态，不看语义。 */
function usable(en: string): boolean {
  if (en.length === 0 || en.length > MAX_EN_CHARS) return false;
  if (PLACEHOLDER.test(en)) return false;
  if (!/[A-Za-z]/.test(en)) return false;
  const tokens = en.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.length <= MAX_TOKENS;
}

function addVariant(draft: Draft, zh: string, key: string): void {
  const keys = draft.variants.get(zh);
  if (keys === undefined) draft.variants.set(zh, [key]);
  else if (!keys.includes(key)) keys.push(key);
}

/** 候选只从 changed 行取；上下文取全文，未改动的行也算证据。 */
export function extractTermCandidates(
  pack: Pack,
  index: TermIndex | null,
  options: CandidateOptions = {},
): TermCandidate[] {
  const minCount = options.minCount ?? 2;
  const contextLimit = options.contexts ?? 6;
  const limit = options.limit ?? 80;
  const drafts = new Map<string, Draft>();
  for (const workspace of pack.workspaces) {
    for (const row of workspace.rows) {
      if (!row.changed) continue;
      const en = (row.headEn ?? "").trim();
      if (!usable(en)) continue;
      const id = en.toLowerCase();
      const draft = drafts.get(id) ?? { en, count: 0, registration: false, variants: new Map(), contexts: [] };
      draft.count += 1;
      draft.registration ||= REGISTRATION.test(row.key) && row.key.split(".").length === 3;
      const zh = (row.headZh ?? "").trim();
      if (zh !== "") addVariant(draft, zh, row.key);
      drafts.set(id, draft);
    }
  }
  for (const draft of drafts.values()) {
    if (draft.registration || draft.count >= minCount) continue;
    drafts.delete(draft.en.toLowerCase());
  }
  for (const workspace of pack.workspaces) {
    for (const row of workspace.rows) {
      const draft = drafts.get((row.headEn ?? "").trim().toLowerCase());
      if (draft === undefined || draft.contexts.length >= contextLimit) continue;
      draft.contexts.push({ key: row.key, en: row.headEn ?? "", zh: row.headZh ?? "" });
    }
  }
  const candidates: TermCandidate[] = [];
  for (const draft of drafts.values()) {
    const inPr: TermVariant[] = [...draft.variants.entries()]
      .map(([zh, keys]) => ({ zh, keys: keys.slice(0, MAX_KEYS), count: keys.length }))
      .sort((a, b) => b.count - a.count || a.zh.localeCompare(b.zh));
    const vanilla = index === null ? [] : lookupTerm(index, draft.en, 5).filter((hit) => hit.en.trim().toLowerCase() === draft.en.toLowerCase());
    const kinds = new Set(vanilla.flatMap((hit) => hit.zh));
    const suggest = kinds.size === 1 ? "lock" : kinds.size > 1 || inPr.length > 1 ? "pending" : "new";
    candidates.push({
      en: draft.en,
      count: draft.count,
      inPr,
      contexts: draft.contexts,
      ...(kinds.size === 0 ? {} : { vanilla: { zh: [...kinds] } }),
      suggest,
    });
  }
  candidates.sort(
    (a, b) =>
      Number(b.suggest === "pending") - Number(a.suggest === "pending") ||
      b.count - a.count ||
      a.en.localeCompare(b.en),
  );
  return candidates.slice(0, limit);
}

/** 折叠块粘在审查正文末尾；discard 不进表，只留在 JSON 里备查。 */
export function renderTermBlock(terms: readonly TermEntry[]): string {
  const shown = terms.filter((entry) => entry.bucket !== "discard");
  if (shown.length === 0) return "";
  const locked = shown.filter((entry) => entry.bucket === "lock").length;
  const rows = shown
    .map(
      (entry) =>
        `| ${entry.en.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${entry.zh.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${entry.source.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
    )
    .join("\n");
  return [
    `<details>`,
    `<summary>术语表（${shown.length} 条：锁定 ${locked} / 新建 ${shown.length - locked}）</summary>`,
    "",
    "| en | zh | 依据 |",
    "|---|---|---|",
    rows,
    "",
    "</details>",
  ].join("\n");
}

/** 片头只放定译，逐字照用；行数受预算约束。 */
export function renderSliceTerms(terms: readonly TermEntry[], cap: number, prNumber: number): string[] {
  const shown = terms.filter((entry) => entry.bucket !== "discard").slice(0, cap);
  if (shown.length === 0) return [];
  const lines = shown.map((entry) => `${entry.en} = ${entry.zh}`);
  const hidden = terms.filter((entry) => entry.bucket !== "discard").length - shown.length;
  return [
    "## 术语表（已冻结，逐字照用）",
    ...lines,
    ...(hidden > 0 ? [`…另 ${hidden} 条见 pr://${prNumber}/terms`] : []),
    "表里没有的词不要自行定译：写 termProposals（kind=missing）；认为锁定项有错写 dispute。",
    "",
    "",
  ];
}

export function parseTermInput(
  content: string,
  n: number,
  headSha: string,
): { table?: TermTable; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (err) {
    return { errors: [`术语表不是有效 JSON：${err instanceof Error ? err.message : String(err)}`] };
  }
  const value =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) && "terms" in raw && Array.isArray(raw.terms)
      ? raw.terms
      : raw;
  if (!Array.isArray(value)) return { errors: ["术语表要写成数组，或 {terms:[…]}。"] };
  const terms: TermEntry[] = [];
  const errors: string[] = [];
  value.forEach((item, index) => {
    const where = `terms[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${where}: 必须是对象`);
      return;
    }
    const record = item as Record<string, unknown>;
    const en = typeof record.en === "string" ? record.en.trim() : "";
    const zh = typeof record.zh === "string" ? record.zh.trim() : "";
    const bucket = record.bucket;
    const source = typeof record.source === "string" ? record.source.trim() : "";
    const note = typeof record.note === "string" ? record.note.trim() : "";
    if (bucket !== "lock" && bucket !== "new" && bucket !== "discard") {
      errors.push(`${where}: bucket 只能是 lock / new / discard`);
      return;
    }
    terms.push({
      en,
      zh,
      bucket,
      source,
      ...(note === "" ? {} : { note }),
    });
  });
  if (errors.length > 0) return { errors };
  return { table: { prNumber: n, headSha, terms, updatedAt: new Date().toISOString() }, errors: [] };
}

/** 表是给子代理照抄的：en 必须真在包里，lock/new 必须有中文和依据。 */
export function validateTermTable(table: TermTable, pack: Pack): string[] {
  const errors: string[] = [];
  if (table.prNumber !== pack.prNumber) errors.push(`prNumber=${table.prNumber} 与目标 PR #${pack.prNumber} 不一致。`);
  if (table.headSha !== pack.headSha) {
    errors.push(`术语表基于 ${table.headSha.slice(0, 7)}，当前 head 是 ${pack.headSha.slice(0, 7)}；重审后再写。`);
  }
  if (table.terms.length === 0) errors.push("术语表为空；至少写一条，或跳过本步。");
  const known = new Set<string>();
  for (const workspace of pack.workspaces) {
    for (const row of workspace.rows) {
      const en = (row.headEn ?? "").trim().toLowerCase();
      if (en !== "") known.add(en);
    }
  }
  const seen = new Set<string>();
  table.terms.forEach((entry, index) => {
    const where = `terms[${index}] ${entry.en || "(空)"}`;
    if (entry.en === "") {
      errors.push(`${where}: en 不能为空`);
      return;
    }
    const id = entry.en.toLowerCase();
    if (seen.has(id)) errors.push(`${where}: en 重复`);
    seen.add(id);
    if (!known.has(id)) errors.push(`${where}: 不在本 PR 的语言包原文里`);
    if (entry.bucket === "discard") {
      if (entry.note === undefined || entry.note === "") errors.push(`${where}: discard 必须写 note 说明为什么不是术语`);
      return;
    }
    if (entry.zh === "") errors.push(`${where}: ${entry.bucket} 必须有中文`);
    if (entry.source === "") errors.push(`${where}: 必须写 source（语料命中、原版术语或既有译法）`);
  });
  return errors;
}

export function termCounts(terms: readonly TermEntry[]): { lock: number; new: number; discard: number } {
  const counts = { lock: 0, new: 0, discard: 0 };
  for (const entry of terms) counts[entry.bucket] += 1;
  return counts;
}
