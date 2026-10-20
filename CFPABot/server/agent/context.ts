import type { WriteScope } from "../../shared/api.ts";
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
  local(name: string): Promise<LocalEntry | null>;
  saveLocal(name: string, content: string): Promise<LocalEntry>;
  listLocal(): Promise<LocalFileInfo[]>;
  packFor(prNumber: number, headSha: string): Promise<Pack | null>;
  savePackFor(prNumber: number, headSha: string, pack: Pack): Promise<void>;
}
