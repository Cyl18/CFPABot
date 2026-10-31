import { z } from "zod";
import type { DraftComment, ReviewDraft, ReviewEvent, Severity } from "@cfpa/contracts/api";
import { REVIEW_EVENTS } from "@cfpa/contracts/api";
import { MQM_BY_ID } from "@cfpa/contracts/mqm";
import { inHunks, patchHeadLines, patchHunks } from "./domain/diff.ts";
import { renderTermBlock } from "./domain/term-table.ts";

/** 模型给的评论：line 可省，服务端按 path+key 从 pack 定位；手册评论没有 key，省略或留空。 */
const draftCommentInput = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  key: z.string().default(""),
  severity: z.enum(["critical", "major", "minor", "neutral"]).optional(),
  mqm: z.string(),
  en: z.string().optional(),
  zh: z.string().optional(),
  body: z.string(),
  suggestion: z.string().optional(),
  covers: z.array(z.string()).optional(),
  suspected: z.boolean().optional(),
  fileLevel: z.boolean().optional(),
});

/** 确实不审的片：identical 需 identicalTo，服务端比对两片文档。 */
export const draftSkipSchema = z.object({
  slice: z.string().min(1),
  reason: z.enum(["identical", "out-of-scope"]),
  identicalTo: z.string().optional(),
});

export type DraftSkip = z.infer<typeof draftSkipSchema>;

export const draftInputSchema = z.object({
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1).optional(),
  event: z.enum(REVIEW_EVENTS),
  summary: z.string(),
  comments: z.array(draftCommentInput),
  skipped: z.array(draftSkipSchema).optional(),
});

export const DRAFT_FILE = "draft.json";

export const reviewDraftSchema = draftInputSchema.extend({
  headSha: z.string().min(1),
  comments: z.array(
    draftCommentInput.extend({
      severity: z.enum(["critical", "major", "minor", "neutral"]),
    }),
  ),
  terms: z
    .array(
      z.object({
        en: z.string(),
        zh: z.string(),
        bucket: z.enum(["lock", "new", "discard"]),
        source: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  updatedAt: z.string(),
  publishedAt: z.string().optional(),
  publishedUrl: z.string().optional(),
});

export function normalizeDraftJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    comments: Array.isArray(record.comments)
      ? record.comments.map((comment, index) =>
          comment !== null && typeof comment === "object"
            ? { id: `c${index + 1}`, ...(comment as Record<string, unknown>) }
            : comment,
        )
      : record.comments,
  };
}

export function parseDraftFile(content: string | undefined): ReviewDraft | null {
  if (content === undefined) return null;
  try {
    const parsed = reviewDraftSchema.safeParse(normalizeDraftJson(JSON.parse(content) as unknown));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializeDraftFile(draft: ReviewDraft): string {
  return JSON.stringify(draft);
}

export interface DraftContext {
  /** 省略时只校验草稿自身；发布路径必须提供，用于核对行号落在 diff hunk 内。 */
  patches?: Map<string, string | undefined>;
}

const SEVERITIES: Severity[] = ["critical", "major", "minor", "neutral"];
const EVENT_LABEL: Record<ReviewEvent, string> = { APPROVE: "可以合", COMMENT: "不能合，按评论改", REQUEST_CHANGES: "不能合，问题太大" };

export function validateDraft(
  draft: Omit<ReviewDraft, "updatedAt" | "publishedAt" | "publishedUrl">,
  ctx: DraftContext,
): string[] {
  const errors: string[] = [];
  const headLines = new Map<string, Map<number, string>>();
  const headLinesOf = (path: string, patch: string): Map<number, string> => {
    const cached = headLines.get(path);
    if (cached !== undefined) return cached;
    const lines = patchHeadLines(patch);
    headLines.set(path, lines);
    return lines;
  };
  if (!EVENT_LABEL[draft.event]) errors.push(`event 非法: ${draft.event}`);
  if (!draft.summary.trim()) errors.push("summary 不能为空");
  if (!Number.isInteger(draft.prNumber) || draft.prNumber <= 0) errors.push("prNumber 非法");
  if (!draft.headSha?.trim()) errors.push("headSha 不能为空");
  const seen = new Map<string, number>();
  draft.comments.forEach((comment, index) => {
    const fileLevel = comment.fileLevel === true;
    const where = `${index + 1}. ${comment.path}:${fileLevel ? "(文件级)" : (comment.line ?? "(无行号)")}`;
    if (!comment.path.trim()) errors.push(`${where}: path 不能为空`);
    if (!SEVERITIES.includes(comment.severity)) errors.push(`${where}: severity 非法: ${comment.severity}`);
    if (!comment.body.trim()) errors.push(`${where}: body 不能为空`);
    if (typeof comment.mqm !== "string" || !MQM_BY_ID.has(comment.mqm)) {
      const [dim = "", leaf = ""] = typeof comment.mqm === "string" ? comment.mqm.split("/") : [];
      const known = [...MQM_BY_ID.keys()].filter((id) => id.startsWith(`${dim}/`) || (leaf !== "" && id.endsWith(`/${leaf}`)));
      errors.push(
        `${where}: mqm 不在词表中: ${comment.mqm}${known.length > 0 ? `（可用：${known.join("、")}）` : ""}`,
      );
    }
    if (fileLevel) {
      if (comment.line !== undefined) errors.push(`${where}: 文件级评论不要给 line，line 与 fileLevel 二选一`);
      if (comment.key.trim() !== "") errors.push(`${where}: 文件级评论不要给 key，key 与 fileLevel 二选一`);
      if (comment.suggestion !== undefined) {
        errors.push(`${where}: 文件级评论不支持 suggestion（整行替换必须落到具体行）`);
      }
    } else if (comment.line === undefined || !Number.isInteger(comment.line) || comment.line <= 0) {
      errors.push(`${where}: 手册评论要给 line（文件行级），或标 fileLevel:true 落到整个文件`);
    }
    if (comment.key.trim() !== "") {
      const slot = `${comment.path}\u0000${comment.key}`;
      const first = seen.get(slot);
      if (first !== undefined) errors.push(`${where}: key 重复（与第 ${first} 条同 path 同 key），其余实例放进 covers`);
      else seen.set(slot, index + 1);
    }
    if (comment.suspected && (comment.severity === "critical" || comment.severity === "major")) {
      errors.push(`${where}: 存疑项 severity 不能高于 minor`);
    }
    if (!fileLevel && !comment.suspected && !comment.suggestion?.trim()) {
      errors.push(
        `${where}: 非存疑的意见必须给出 suggestion（语言包可改给 zhNew，但 path+line 必须能在 pack 里找到该行；covers 不替代）`,
      );
    }
    if (ctx.patches === undefined) return;
    if (!ctx.patches.has(comment.path)) {
      errors.push(`${where}: 该文件不在本次 PR 变更中`);
      return;
    }
    if (fileLevel) return;
    const line = comment.line;
    if (line === undefined) return;
    const patch = ctx.patches.get(comment.path);
    if (patch === undefined || patch === "") {
      errors.push(`${where}: 该文件的 diff 无法取得，不能确定行号，请改用其它定位方式或不写行内评论`);
      return;
    }
    if (!inHunks(line, patchHunks(patch))) {
      errors.push(`${where}: 行号不在 diff hunk 内`);
      return;
    }
    if (comment.suggestion === undefined) return;
    const head = headLinesOf(comment.path, patch).get(line);
    if (head === undefined) return;
    const problem = wholeLineProblem(comment.path, head, comment.suggestion);
    if (problem !== undefined) {
      errors.push(`${where}: suggestion ${problem}；head 该行是 ${JSON.stringify(head)}`);
    }
  });
  return errors;
}

/** suggestion 是整行替换：缩进、行尾逗号跟 head 行一致，json 文件还要能单独解析成一条。 */
function wholeLineProblem(path: string, head: string, suggestion: string): string | undefined {
  const [headIndent = ""] = /^\s*/.exec(head) ?? [];
  const [suggestionIndent = ""] = /^\s*/.exec(suggestion) ?? [];
  if (headIndent !== suggestionIndent) return "的缩进与 head 行不一致";
  if (head.trimEnd().endsWith(",") !== suggestion.trimEnd().endsWith(",")) return "的行尾逗号与 head 行不一致";
  if (!path.endsWith(".json")) return undefined;
  try {
    JSON.parse(`{${suggestion.trim().replace(/,$/, "")}}`);
    return undefined;
  } catch {
    return "不是完整的一行 JSON 条目（引号、逗号、转义要与文件一致）";
  }
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, major: 3, minor: 2, neutral: 1 };

/** 档位低于词表默认值的条目，只提示不拦。 */
export function severityWarnings(draft: Pick<ReviewDraft, "comments">): string[] {
  const warnings: string[] = [];
  for (const comment of draft.comments) {
    const type = MQM_BY_ID.get(comment.mqm);
    if (type === undefined || comment.suspected === true) continue;
    if (SEVERITY_RANK[comment.severity] < SEVERITY_RANK[type.severity]) {
      warnings.push(
        `${comment.path}:${comment.line ?? "(文件级)"} ${comment.key}: ${type.label}默认档位 ${type.severity}，当前 ${comment.severity}；后果确实更轻才保留`,
      );
    }
  }
  return warnings;
}

export function foldDisplayBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\$\(br2\)/g, "\n\n")
    .replace(/\$\(br\)/g, "\n")
    .replace(/<newline>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/p>/g, "\n")
    .replace(/<p>/g, "\n");
}

export function renderInlineBody(comment: DraftComment): string {
  const covers = comment.covers?.length ?? 0;
  const type = MQM_BY_ID.get(comment.mqm);
  const parts = [
    `\`${comment.severity}\` · ${type === undefined ? comment.mqm : `${type.label}（${comment.mqm}）`}${covers > 0 ? ` · covers ${covers} key` : ""}`,
  ];
  if (comment.en !== undefined) parts.push(`原文：\n\`\`\`\n${foldDisplayBreaks(comment.en)}\n\`\`\``);
  if (comment.zh !== undefined) parts.push(`译文：\n\`\`\`\n${foldDisplayBreaks(comment.zh)}\n\`\`\``);
  parts.push(comment.body.trim());
  if (comment.suggestion) parts.push(`\`\`\`suggestion\n${comment.suggestion}\n\`\`\``);
  if (covers > 0) {
    const rows = (comment.covers ?? []).map((key) => `| \`${key}\` |`).join("\n");
    parts.push(`<details><summary>covers ${covers} key</summary>\n\n| key |\n|---|\n${rows}\n\n</details>`);
  }
  return parts.join("\n\n");
}

export function renderReviewBody(draft: ReviewDraft): string {
  const inline = draft.comments.filter((comment) => comment.fileLevel !== true);
  const fileLevel = draft.comments.filter((comment) => comment.fileLevel === true);
  const major = inline.filter((comment) => comment.severity === "major" || comment.severity === "critical").length;
  const minor = inline.length - major;
  return [
    `本批共 ${inline.length} 条 inline（major ${major} / minor ${minor}）${fileLevel.length === 0 ? "" : `、${fileLevel.length} 条文件级`}，结论：**${EVENT_LABEL[draft.event]}**。`,
    draft.summary.trim(),
    ...(fileLevel.length === 0
      ? []
      : ["### 文件级意见", ...fileLevel.map((comment) => `**\`${comment.path}\`**\n\n${renderInlineBody(comment)}`)]),
    renderTermBlock(draft.terms ?? []),
    "⚠️ 本批意见由 LLM 生成，仅供参考，不代表正式审查意见。",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}
