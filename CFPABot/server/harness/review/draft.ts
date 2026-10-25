import type { DraftSchemaView, ReviewDraft, ReviewDraftView } from "@cfpa/contracts/api";
import {
  DRAFT_FILE,
  draftInputSchema,
  normalizeDraftJson,
  parseDraftFile,
  serializeDraftFile,
  severityWarnings,
  validateDraft,
} from "@cfpa/review-core/draft";
import type { Pack } from "@cfpa/review-core/pack";
import { readLocal, writeLocal } from "../../agent/local-store.ts";
import { prdata } from "../../prdata.ts";
import { loadPack } from "../pack.ts";

export interface PrepareResult {
  draft?: ReviewDraft;
  errors: string[];
}

export interface SaveResult {
  ok: boolean;
  draft?: ReviewDraft;
  errors: string[];
  warnings: string[];
  next: string[];
}

function jsonPayload(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

interface RowFact {
  key: string;
  en?: string;
  zh?: string;
  raw?: string;
}

function rowFacts(pack: Pack): Map<string, RowFact> {
  const facts = new Map<string, RowFact>();
  for (const workspace of pack.workspaces) {
    if (workspace.zhPath === null) continue;
    for (const row of workspace.rows) {
      if (row.line === null) continue;
      facts.set(`${workspace.zhPath}\u0000${row.line}`, {
        key: row.key,
        ...(row.headEn === undefined ? {} : { en: row.headEn }),
        ...(row.headZh === undefined ? {} : { zh: row.headZh }),
        ...(row.headRaw === undefined ? {} : { raw: row.headRaw }),
      });
    }
  }
  return facts;
}

/** 整行替换由服务端拼：缩进、引号、逗号、转义都跟 head 原行走。 */
export function composeSuggestion(path: string, key: string, raw: string, value: string): string {
  const indent = /^\s*/.exec(raw)?.[0] ?? "";
  if (!path.endsWith(".json")) return `${indent}${key}=${value}`;
  const comma = raw.trimEnd().endsWith(",") ? "," : "";
  return `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`;
}

/** 子代理只给判断与 zhNew；en/zh 和整行 suggestion 从 pack 补。 */
export async function withServerFilledFields(n: number, content: string, pack?: Pack): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload(content)) as unknown;
  } catch {
    return content;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return content;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.comments) || record.comments.length === 0) return content;
  let facts: Map<string, RowFact>;
  try {
    facts = rowFacts(pack ?? (await loadPack(n)));
  } catch {
    return content;
  }
  let touched = false;
  const comments = record.comments.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const comment = { ...(entry as Record<string, unknown>) };
    const path = typeof comment.path === "string" ? comment.path : "";
    const line = typeof comment.line === "number" ? comment.line : Number.NaN;
    const fact = facts.get(`${path}\u0000${line}`);
    const zhNew = typeof comment.zhNew === "string" ? comment.zhNew : "";
    if (fact !== undefined) {
      if ((comment.en === undefined || comment.en === "") && fact.en !== undefined) {
        comment.en = fact.en;
        touched = true;
      }
      if ((comment.zh === undefined || comment.zh === "") && fact.zh !== undefined) {
        comment.zh = fact.zh;
        touched = true;
      }
      if (
        (comment.suggestion === undefined || comment.suggestion === "") &&
        zhNew !== "" &&
        fact.raw !== undefined
      ) {
        comment.suggestion = composeSuggestion(path, fact.key, fact.raw, zhNew);
        touched = true;
      }
    }
    if ("zhNew" in comment) {
      delete comment.zhNew;
      touched = true;
    }
    return comment;
  });
  return touched ? JSON.stringify({ ...record, comments }) : content;
}

/** 填掉服务端已知字段再校验：模型不必重复抄 headSha 和 prNumber。 */
export function prepareDraft(content: string, n: number, headSha: string): PrepareResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonPayload(content)) as unknown;
  } catch (err) {
    return { errors: [`草稿不是有效 JSON：${err instanceof Error ? err.message : String(err)}`] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ["草稿必须是 JSON 对象。"] };
  }
  const record = { ...(raw as Record<string, unknown>) };
  const prNumber = record.prNumber === undefined ? n : Number(record.prNumber);
  if (prNumber !== n) return { errors: [`草稿 prNumber=${prNumber} 与目标 PR #${n} 不一致。`] };
  record.prNumber = n;
  if (record.headSha === undefined || record.headSha === "") record.headSha = headSha;
  const normalized = normalizeDraftJson(record);
  const parsed = draftInputSchema.safeParse(normalized);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "草稿"}: ${issue.message}`) };
  }
  const input = parsed.data;
  return {
    draft: {
      prNumber: input.prNumber,
      headSha: input.headSha ?? headSha,
      verdict: input.verdict,
      summary: input.summary,
      comments: input.comments,
      ...(input.event === undefined ? {} : { event: input.event }),
      updatedAt: new Date().toISOString(),
    },
    errors: [],
  };
}

/** 读会话里的草稿：brief、draft 视图与发布共用同一份解析。 */
export async function storedDraftOf(sessionId?: string): Promise<ReviewDraft | null> {
  if (sessionId === undefined) return null;
  const raw = await readLocal(sessionId, DRAFT_FILE);
  return raw === null ? null : parseDraftFile(raw.content);
}

export function draftSchema(n: number, headSha: string): DraftSchemaView {
  return {
    shape: {
      prNumber: n,
      headSha,
      verdict: "approve | changes | reject",
      summary: "一两句总结；不要写统计、档位标题或免责声明，服务端会拼",
      comments: [
        {
          path: "projects/assets/<mod>/<版本>/<namespace>/lang/zh_cn.json",
          line: 12,
          key: "item.example",
          severity: "critical | major | minor | neutral",
          mqm: "accuracy/mistranslation",
          body: "为什么错、后果是什么；不要重复原文/译文",
          en: "可省：原文，服务端按 path+line 补",
          zh: "可省：当前译文，服务端按 path+line 补",
          zhNew: "语言包用：只给新译文本身，不带引号、缩进、逗号；整行由服务端拼",
          suggestion: "整行替换后的译文；手册类评论用，缩进/引号/转义与文件一致",
          covers: ["同一 pattern 的其余 key"],
          suspected: false,
        },
      ],
    },
    notes: [
      "评论的 path 是 zh_cn 文件路径，line 是 head 行号且必须在 diff hunk 新侧；rows 已给 path/line/inHunk。",
      "同一 path+key 只能出一条；同一模式的其余 key 放进 covers，两者可以同时给（suggestion 只替换当前行，缩进与行尾逗号要跟 head 该行一致）。",
      "非 suspected 的评论必须能拼出 suggestion：语言包给 zhNew，手册类给 suggestion（covers 不替代）；suspected 时 severity 不得高于 minor。",
      "id 可省，服务端按顺序补 c1…cN；headSha 可省，服务端按当前 head 补。",
      "write pr://<n>/draft 保存并校验，errors 会直接返回，不通过不落盘。",
      "发布用 write pr://<n>/review；event 可写进草稿，发布时 ?event=APPROVE|REQUEST_CHANGES 优先。",
    ],
  };
}

async function patchesOf(n: number): Promise<Map<string, string | undefined>> {
  const { files } = await prdata.files(n);
  return new Map(files.map((file) => [file.path, file.patch]));
}

export async function readDraftOf(n: number, sessionId?: string): Promise<ReviewDraftView> {
  const { pull } = await prdata.files(n);
  const draft = await storedDraftOf(sessionId);
  const errors: string[] = [];
  const warnings: string[] = [];
  const headCurrent = draft === null || draft.headSha === pull.headSha;
  if (draft !== null) {
    if (draft.prNumber !== n) {
      errors.push(`草稿属于 PR #${draft.prNumber}，当前目标是 PR #${n}；重新审目标 PR。`);
    } else if (!headCurrent) {
      errors.push(`草稿基于 ${draft.headSha.slice(0, 7)}，当前 head 是 ${pull.headSha.slice(0, 7)}；重审后再发布。`);
    }
    errors.push(...validateDraft(draft, { patches: await patchesOf(n) }));
    warnings.push(...severityWarnings(draft));
  }
  return {
    prNumber: n,
    headSha: pull.headSha,
    exists: draft !== null,
    draft,
    schema: draftSchema(n, pull.headSha),
    validation: { errors, warnings, headCurrent },
    write: `pr://${n}/draft`,
    publish: `pr://${n}/review`,
    next:
      draft === null
        ? [`write pr://${n}/draft <JSON>`, `read pr://${n}?review=1`]
        : errors.length > 0
          ? [`按 errors 修完后重写 pr://${n}/draft`]
          : [`write pr://${n}/review 发布`, `read pr://${n}/draft 复核`],
  };
}

export async function saveDraftOf(n: number, sessionId: string, content: string): Promise<SaveResult> {
  const { pull } = await prdata.files(n);
  const prepared = prepareDraft(await withServerFilledFields(n, content), n, pull.headSha);
  if (prepared.draft === undefined) return { ok: false, errors: prepared.errors, warnings: [], next: [] };
  if (prepared.draft.headSha !== pull.headSha) {
    return {
      ok: false,
      errors: [`草稿基于 ${prepared.draft.headSha.slice(0, 7)}，当前 head 是 ${pull.headSha.slice(0, 7)}；重审后再保存。`],
      warnings: [],
      next: [`read pr://${n}?review=1`],
    };
  }
  const errors = validateDraft(prepared.draft, { patches: await patchesOf(n) });
  if (errors.length > 0) return { ok: false, errors, warnings: [], next: [] };
  const warnings = severityWarnings(prepared.draft);
  await writeLocal(sessionId, DRAFT_FILE, serializeDraftFile(prepared.draft));
  return {
    ok: true,
    draft: prepared.draft,
    errors: [],
    warnings,
    next: [`write pr://${n}/review 发布`, `read pr://${n}/draft 复核`],
  };
}

export async function markPublishedOf(
  n: number,
  sessionId: string,
  draft: ReviewDraft,
  url: string,
): Promise<ReviewDraft> {
  const value: ReviewDraft = { ...draft, publishedAt: new Date().toISOString(), publishedUrl: url };
  await writeLocal(sessionId, DRAFT_FILE, serializeDraftFile(value));
  return value;
}
