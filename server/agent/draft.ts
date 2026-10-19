import { z } from "zod";
import type { DraftComment, ReviewDraft, Severity, Verdict } from "../../shared/api.ts";
import { inHunks, patchHunks } from "../domain/diff.ts";
import type { MqmLabel } from "./mqm.ts";

export const draftInputSchema = z.object({
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1).optional(),
  verdict: z.enum(["approve", "changes", "reject"]),
  summary: z.string(),
  comments: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      line: z.number().int().positive(),
      key: z.string(),
      severity: z.enum(["critical", "major", "minor", "neutral"]),
      mqm: z.string(),
      en: z.string().optional(),
      zh: z.string().optional(),
      body: z.string(),
      suggestion: z.string().optional(),
      covers: z.array(z.string()).optional(),
      suspected: z.boolean().optional(),
    }),
  ),
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).optional(),
});

export const DRAFT_FILE = "draft.json";

export const reviewDraftSchema = draftInputSchema.omit({ event: true }).extend({
  headSha: z.string().min(1),
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
  mqmIds: Set<string>;
  labels: Map<string, MqmLabel>;
  patches: Map<string, string | undefined>;
}

const SEVERITIES: Severity[] = ["critical", "major", "minor", "neutral"];
const VERDICT_LABEL: Record<Verdict, string> = { approve: "可合", changes: "需改后合", reject: "退回" };

export function validateDraft(
  draft: Omit<ReviewDraft, "updatedAt" | "publishedAt" | "publishedUrl">,
  ctx: DraftContext,
): string[] {
  const errors: string[] = [];
  if (!VERDICT_LABEL[draft.verdict]) errors.push(`verdict 非法: ${draft.verdict}`);
  if (!draft.summary.trim()) errors.push("summary 不能为空");
  if (!Number.isInteger(draft.prNumber) || draft.prNumber <= 0) errors.push("prNumber 非法");
  draft.comments.forEach((comment, index) => {
    const where = `${index + 1}. ${comment.path}:${comment.line}`;
    if (!comment.path.trim()) errors.push(`${where}: path 不能为空`);
    if (!Number.isInteger(comment.line) || comment.line <= 0) errors.push(`${where}: line 必须是正整数`);
    if (!SEVERITIES.includes(comment.severity)) errors.push(`${where}: severity 非法: ${comment.severity}`);
    if (!comment.body.trim()) errors.push(`${where}: body 不能为空`);
    if (ctx.mqmIds.size > 0 && !ctx.mqmIds.has(comment.mqm)) {
      errors.push(`${where}: mqm 非法（须 Dim/type 全形）: ${comment.mqm}`);
    }
    if (comment.covers && comment.covers.length > 0 && comment.suggestion) {
      errors.push(`${where}: covers 非空时不能同时给 suggestion`);
    }
    if (comment.suspected && (comment.severity === "critical" || comment.severity === "major")) {
      errors.push(`${where}: 存疑项 severity 不能高于 minor`);
    }
    if (!ctx.patches.has(comment.path)) {
      errors.push(`${where}: 该文件不在本次 PR 变更中`);
      return;
    }
    const patch = ctx.patches.get(comment.path);
    if (patch === undefined || patch === "") {
      errors.push(`${where}: 该文件的 diff 无法取得，不能确定行号，请改用其它定位方式或不写行内评论`);
      return;
    }
    if (!inHunks(comment.line, patchHunks(patch))) errors.push(`${where}: 行号不在 diff hunk 内`);
    if (!comment.suspected && (comment.covers?.length ?? 0) === 0 && !comment.suggestion?.trim()) {
      errors.push(`${where}: 非存疑且没有 covers 的意见必须给出 suggestion（该行替换后的完整译文）`);
    }
  });
  return errors;
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

export function renderInlineBody(comment: DraftComment, labels: Map<string, MqmLabel>): string {
  const label = labels.get(comment.mqm);
  const covers = comment.covers?.length ?? 0;
  const parts = [
    `\`${comment.severity}\` · ${comment.mqm}${label ? `（${label.dimZh}/${label.typeZh}）` : ""}${covers > 0 ? ` · covers ${covers} key` : ""}`,
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
  const major = draft.comments.filter((comment) => comment.severity === "major" || comment.severity === "critical").length;
  const minor = draft.comments.length - major;
  return [
    `本批共 ${draft.comments.length} 条 inline（major ${major} / minor ${minor}），verdict：**${VERDICT_LABEL[draft.verdict]}**。`,
    draft.summary.trim(),
    "⚠️ 本批意见由 LLM 生成，仅供参考，不代表正式审查意见。",
  ].join("\n\n");
}
