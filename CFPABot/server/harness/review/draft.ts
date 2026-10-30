import type { DraftSchemaView, ReviewDraft, ReviewDraftView } from "@cfpa/contracts/api";
import { MQM_BY_ID, mqmTable } from "@cfpa/contracts/mqm";
import {
  DRAFT_FILE,
  draftInputSchema,
  normalizeDraftJson,
  parseDraftFile,
  serializeDraftFile,
  severityWarnings,
  validateDraft,
  type DraftSkip,
} from "@cfpa/review-core/draft";
import type { Pack } from "@cfpa/review-core/pack";
import { readLocal, writeLocal } from "../../agent/local-store.ts";
import { prdata } from "../../prdata.ts";
import { loadPack } from "../pack.ts";
import { loadTermTable } from "./term-store.ts";
import { MANIFEST_PATH, normalizeSliceDoc, type WorkPackManifest } from "./workpack.ts";
import { loadSubagents } from "../../agent/subagents.ts";

export interface PrepareResult {
  draft?: ReviewDraft;
  skipped?: DraftSkip[];
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
  line: number;
  en?: string;
  zh?: string;
  raw?: string;
}

interface RowFactIndex {
  byLine: Map<string, RowFact>;
  byKey: Map<string, RowFact>;
}

function rowFacts(pack: Pack): RowFactIndex {
  const byLine = new Map<string, RowFact>();
  const byKey = new Map<string, RowFact>();
  for (const workspace of pack.workspaces) {
    if (workspace.zhPath === null) continue;
    for (const row of workspace.rows) {
      if (row.line === null) continue;
      const fact: RowFact = {
        key: row.key,
        line: row.line,
        ...(row.headEn === undefined ? {} : { en: row.headEn }),
        ...(row.headZh === undefined ? {} : { zh: row.headZh }),
        ...(row.headRaw === undefined ? {} : { raw: row.headRaw }),
      };
      byLine.set(`${workspace.zhPath}\u0000${row.line}`, fact);
      byKey.set(`${workspace.zhPath}\u0000${row.key}`, fact);
    }
  }
  return { byLine, byKey };
}

/** 行内评论按 key 定位：path+key 在 pack 里只有一处。 */
export async function lineOfKey(n: number, path: string, key: string): Promise<number | null> {
  const { byKey } = rowFacts(await loadPack(n));
  return byKey.get(`${path}\u0000${key}`)?.line ?? null;
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
  let facts: RowFactIndex;
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
    const key = typeof comment.key === "string" ? comment.key.trim() : "";
    // 行号以 key 为准：手数的 line 会错，key 在 pack 里只有一处。
    const located = key === "" ? undefined : facts.byKey.get(`${path}\u0000${key}`);
    if (located !== undefined && comment.line !== located.line) {
      comment.line = located.line;
      touched = true;
    }
    const line = typeof comment.line === "number" ? comment.line : Number.NaN;
    const fact = located ?? facts.byLine.get(`${path}\u0000${line}`);
    const mqm = typeof comment.mqm === "string" ? comment.mqm.trim() : "";
    if (comment.severity === undefined) {
      const fallback = MQM_BY_ID.get(mqm)?.severity;
      if (fallback !== undefined) {
        comment.severity = fallback;
        touched = true;
      }
    }
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
  const comments: ReviewDraft["comments"] = [];
  for (const comment of input.comments) {
    if (comment.severity === undefined) {
      return {
        errors: [`${comment.path} ${comment.key}: 没有 severity，且 mqm 不在词表里；补 severity 或改用词表里的 mqm`],
      };
    }
    if (comment.fileLevel !== true && comment.line === undefined) {
      return {
        errors: [`${comment.path} ${comment.key}: 手册评论要给 line（文件行级），或标 fileLevel:true 落到整个文件`],
      };
    }
    comments.push({ ...comment, severity: comment.severity });
  }
  return {
    draft: {
      prNumber: input.prNumber,
      headSha: input.headSha ?? headSha,
      verdict: input.verdict,
      summary: input.summary,
      comments,
      ...(input.event === undefined ? {} : { event: input.event }),
      updatedAt: new Date().toISOString(),
    },
    ...(input.skipped === undefined ? {} : { skipped: input.skipped }),
    errors: [],
  };
}

/** 读会话里的草稿：brief、draft 视图与发布共用同一份解析。 */
export async function storedDraftOf(sessionId?: string): Promise<ReviewDraft | null> {
  if (sessionId === undefined) return null;
  const raw = await readLocal(sessionId, DRAFT_FILE);
  return raw === null ? null : parseDraftFile(raw.content);
}

export function draftSchema(n: number, headSha: string, notes = true): DraftSchemaView {
  return {
    shape: {
      prNumber: n,
      headSha,
      verdict: "approve | changes | reject",
      summary: "一两句总结；不要写统计、档位标题或免责声明，服务端会拼",
      comments: [
        {
          path: "projects/assets/<mod>/<版本>/<namespace>/lang/zh_cn.json",
          line: "文件行级锚点：手册评论给 head 行号；给了 key 就按 path+key 定位",
          key: "语言包评论必填；手册（.md）评论省略或留空",
          fileLevel: "手册评论可选：true 表示落到整个文件，此时不给 line、key、suggestion",
          severity: "可省：按 mqm 默认档补；后果不同才显式改",
          mqm: "accuracy/mistranslation",
          body: "为什么错、后果是什么；不要重复原文/译文",
          en: "可省：原文，服务端按 path+key 或 line 补",
          zh: "可省：当前译文，服务端按 path+key 或 line 补",
          zhNew: "语言包用：只给新译文本身，不带引号、缩进、逗号；整行由服务端拼。含换行写 \\n，例：\"第一行\\n第二行\"",
          suggestion: "整行替换后的译文；手册类评论用，缩进/引号/转义与文件一致",
          covers: ["同一 pattern 的其余 key"],
          suspected: false,
        },
      ],
      skipped: [{ slice: "<片 id>", reason: "identical", identicalTo: "<已审片 id>" }],
    },
    mqm: mqmTable().split("\n"),
    notes: notes
      ? [
          "评论的 path 是 zh_cn 文件路径；line 可省，给了 key 就按 path+key 定位（手写的 line 会被 key 覆盖）。",
          "手册（.md）评论锚点二选一：给 path+line（文件行级），或标 fileLevel:true（文件级，进正文不进 inline）。",
          "同一 path+key 只能出一条；同一模式的其余 key 放进 covers，两者可以同时给（suggestion 只替换当前行，缩进与行尾逗号要跟 head 该行一致）。",
          "非 suspected 的评论必须能拼出 suggestion：语言包给 zhNew，手册类给 suggestion（covers 不替代）；suspected 时 severity 不得高于 minor。",
          "id 可省，服务端按顺序补 c1…cN；headSha 可省，服务端按当前 head 补。",
          "mqm 只取本回包 mqm 字段里的全形 id，不自编。",
          "术语表不写进草稿：服务端按 pr://<n>/terms 的冻结表挂到正文折叠块；改了表先重打 pack 再保存草稿。",
          "write pr://<n>/draft 保存并校验，errors 会直接返回，不通过不落盘。",
          "保存和发布都会核对覆盖率：pack 里每片都要有子代理正常跑完（slices 记录在该子代理上）；漏审的片重新 delegate。",
          '内容确与已审片相同的，把该片写进 skipped：[{slice,reason:"identical",identicalTo:"<已审片 id>"}]；服务端比对两片文档（忽略版本号）后才放行。',
          "发布用 write pr://<n>/review；event 缺省按 verdict 推（approve→APPROVE、changes→REQUEST_CHANGES、reject→COMMENT），显式 event 或 ?event= 可覆盖。",
        ]
      : [],
  };
}

async function patchesOf(n: number): Promise<Map<string, string | undefined>> {
  const { files } = await prdata.files(n);
  return new Map(files.map((file) => [file.path, file.patch]));
}

export interface ReadDraftOptions {
  schema?: boolean;
  notes?: boolean;
}

export async function readDraftOf(
  n: number,
  sessionId?: string,
  options: ReadDraftOptions = {},
): Promise<ReviewDraftView> {
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
    ...(options.schema === false ? {} : { schema: draftSchema(n, pull.headSha, options.notes !== false) }),
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

/** 当前 head 的 pack manifest；没有或换 head 返回 null。 */
async function manifestOf(sessionId: string, headSha: string): Promise<WorkPackManifest | null> {
  const raw = await readLocal(sessionId, MANIFEST_PATH);
  if (raw === null) return null;
  try {
    const manifest = JSON.parse(raw.content) as WorkPackManifest;
    return manifest.headSha === headSha ? manifest : null;
  } catch {
    return null;
  }
}

async function doneSliceIds(sessionId: string): Promise<Set<string>> {
  const done = new Set<string>();
  for (const info of await loadSubagents(sessionId)) {
    if (info.status === "done") for (const id of info.slices ?? []) done.add(id);
  }
  return done;
}

/** pack 里存在、但既没跑过也没声明跳过的片。 */
export async function unreviewedSlices(sessionId: string, headSha: string): Promise<string[] | null> {
  const manifest = await manifestOf(sessionId, headSha);
  if (manifest === null) return null;
  const done = await doneSliceIds(sessionId);
  const skipped = new Set((manifest.skipped ?? []).map((item) => item.slice));
  return manifest.slices.map((slice) => slice.id).filter((id) => !done.has(id) && !skipped.has(id));
}

interface SkipResolution {
  errors: string[];
  ids: Set<string>;
  manifest?: WorkPackManifest;
  changed: boolean;
}

/** identical 要拿到两片文档实比；out-of-scope 只记录，别拿 summary 文字当豁免。 */
async function resolveSkips(
  sessionId: string,
  manifest: WorkPackManifest | null,
  skips: readonly DraftSkip[],
  done: ReadonlySet<string>,
): Promise<SkipResolution> {
  const ids = new Set<string>();
  if (skips.length === 0) return { errors: [], ids, changed: false };
  if (manifest === null) {
    return { errors: ["没有可用的 pack（或 head 已变），不能声明跳过；先 write pr://<n>/pack {}。"], ids, changed: false };
  }
  const byId = new Map(manifest.slices.map((slice) => [slice.id, slice]));
  const errors: string[] = [];
  const entries: NonNullable<WorkPackManifest["skipped"]> = [];
  for (const skip of skips) {
    const slice = byId.get(skip.slice);
    if (slice === undefined) {
      errors.push(`skipped: 片 ${skip.slice} 不在本次 pack 里。`);
      continue;
    }
    if (done.has(slice.id)) {
      errors.push(`skipped: 片 ${slice.id} 已有子代理跑过，不需要跳过。`);
      continue;
    }
    if (ids.has(slice.id)) {
      errors.push(`skipped: 片 ${slice.id} 重复声明。`);
      continue;
    }
    const at = new Date().toISOString();
    if (skip.reason === "identical") {
      const target = skip.identicalTo === undefined ? undefined : byId.get(skip.identicalTo);
      if (target === undefined) {
        errors.push(`skipped: ${slice.id} 标了 identical，必须给 pack 里的 identicalTo。`);
        continue;
      }
      if (!done.has(target.id)) {
        errors.push(`skipped: identicalTo 的 ${target.id} 也要有子代理跑完，否则两片都没人审。`);
        continue;
      }
      const [left, right] = await Promise.all([
        readLocal(sessionId, slice.doc.replace(/^local:\/\//, "")),
        readLocal(sessionId, target.doc.replace(/^local:\/\//, "")),
      ]);
      if (left === null || right === null) {
        errors.push(`skipped: 读不到 ${slice.id} / ${target.id} 的片文档。`);
        continue;
      }
      if (normalizeSliceDoc(left.content, slice.id) !== normalizeSliceDoc(right.content, target.id)) {
        errors.push(`skipped: ${slice.id} 与 ${target.id} 除版本号外内容不同，不能按 identical 跳过；老实 delegate。`);
        continue;
      }
      entries.push({ slice: slice.id, reason: "identical", identicalTo: target.id, at });
    } else {
      entries.push({ slice: slice.id, reason: "out-of-scope", at });
    }
    ids.add(slice.id);
  }
  if (errors.length > 0) return { errors, ids, changed: false };
  const merged = (manifest.skipped ?? []).filter((item) => !ids.has(item.slice));
  return { errors: [], ids, manifest: { ...manifest, skipped: [...merged, ...entries] }, changed: entries.length > 0 };
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
  const pending = prepared.draft;
  const errors = validateDraft(pending, { patches: await patchesOf(n) });
  if (errors.length > 0) return { ok: false, errors, warnings: [], next: [] };
  const manifest = await manifestOf(sessionId, pull.headSha);
  const done = await doneSliceIds(sessionId);
  const skip = await resolveSkips(sessionId, manifest, prepared.skipped ?? [], done);
  if (skip.errors.length > 0) return { ok: false, errors: skip.errors, warnings: [], next: [] };
  if (skip.changed && skip.manifest !== undefined) {
    await writeLocal(sessionId, MANIFEST_PATH, JSON.stringify(skip.manifest));
  }
  const uncovered =
    manifest === null
      ? []
      : manifest.slices.map((slice) => slice.id).filter((id) => !done.has(id) && !skip.ids.has(id));
  if (uncovered.length > 0) {
    return {
      ok: false,
      errors: [
        `还有 ${uncovered.length} 片没有子代理跑过：${uncovered.join("、")}。`,
        '内容确与已审片相同的，写 skipped:[{slice,reason:"identical",identicalTo:"<已审片 id>"}] 再保存。',
      ],
      warnings: [],
      next: [`write pr://${n}/pack {} 复核片清单`, "重新 delegate 这些片后重写草稿"],
    };
  }
  const warnings = severityWarnings(pending);
  const table = await loadTermTable(n, pull.headSha);
  const draft: ReviewDraft = table === null ? pending : { ...pending, terms: table.terms };
  await writeLocal(sessionId, DRAFT_FILE, serializeDraftFile(draft));
  return {
    ok: true,
    draft,
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
