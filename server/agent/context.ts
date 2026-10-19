import type { EvalScope, WriteScope } from "../../shared/api.ts";
import type { Pack } from "./pack.ts";

export interface LocalEntry {
  content: string;
  updatedAt: string;
}

export interface LocalFileInfo {
  name: string;
  size: number;
  updatedAt: string;
}

export interface ToolContext {
  sessionId: string;
  prNumber: number | null;
  baseSha: string | null;
  headSha: string | null;
  writeScope: WriteScope;
  evalScope: EvalScope;
  local(name: string): Promise<LocalEntry | null>;
  saveLocal(name: string, content: string): Promise<LocalEntry>;
  listLocal(): Promise<LocalFileInfo[]>;
  packFor(prNumber: number, headSha: string): Promise<Pack | null>;
  savePackFor(prNumber: number, headSha: string, pack: Pack): Promise<void>;
}

export function requirePr(ctx: ToolContext): { prNumber: number; baseSha: string; headSha: string } {
  if (ctx.prNumber === null || !ctx.baseSha || !ctx.headSha) {
    throw new Error("当前会话未绑定 PR，无法使用该工具");
  }
  return { prNumber: ctx.prNumber, baseSha: ctx.baseSha, headSha: ctx.headSha };
}
