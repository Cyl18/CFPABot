import type { ReviewDraft } from "../../shared/api.ts";
import type { Pack } from "./pack.ts";

export interface ToolContext {
  prNumber: number | null;
  baseSha: string | null;
  headSha: string | null;
  pack(): Promise<Pack | null>;
  savePack(pack: Pack): Promise<void>;
  saveDraft(draft: Omit<ReviewDraft, "updatedAt" | "publishedAt" | "publishedUrl">): Promise<ReviewDraft>;
}

export function requirePr(ctx: ToolContext): { prNumber: number; baseSha: string; headSha: string } {
  if (ctx.prNumber === null || !ctx.baseSha || !ctx.headSha) {
    throw new Error("当前会话未绑定 PR，无法使用该工具");
  }
  return { prNumber: ctx.prNumber, baseSha: ctx.baseSha, headSha: ctx.headSha };
}
