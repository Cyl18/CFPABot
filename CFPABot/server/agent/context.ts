import type { EvalScope, WriteScope } from "../../shared/api.ts";

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
}
