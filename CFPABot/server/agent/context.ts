import type { WriteScope } from "../../shared/api.ts";

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
  writeScope: WriteScope;
  local(name: string): Promise<LocalEntry | null>;
  saveLocal(name: string, content: string): Promise<LocalEntry>;
  listLocal(): Promise<LocalFileInfo[]>;
}
