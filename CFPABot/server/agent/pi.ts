import { existsSync } from "node:fs";
import {
  SessionManager,
  type SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { paths } from "../paths.ts";
import type { SessionRecord } from "./sessions.ts";

export async function openSessionManager(record: SessionRecord): Promise<SessionManager> {
  if (record.sessionFile && existsSync(record.sessionFile)) {
    return SessionManager.open(record.sessionFile, paths.sessions);
  }
  const manager = SessionManager.create(paths.root, paths.sessions);
  const file = manager.getSessionFile();
  if (!file) throw new Error("无法创建会话文件。");
  record.sessionFile = file;
  return manager;
}

export async function sessionMessages(record: SessionRecord): Promise<AgentMessage[]> {
  if (!record.sessionFile || !existsSync(record.sessionFile)) return [];
  try {
    const manager = await SessionManager.open(record.sessionFile, paths.sessions);
    const entries: SessionEntry[] = manager.getEntries();
    return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  } catch {
    return [];
  }
}
