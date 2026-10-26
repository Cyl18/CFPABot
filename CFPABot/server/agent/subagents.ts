import { join } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ChatItem, SubagentInfo, SubagentTranscript } from "@cfpa/contracts/api";
import { HttpError } from "../errors.ts";
import { paths } from "../paths.ts";
import { readJson, withLock, writeJson } from "../store.ts";
import { messagesFromFile } from "./pi.ts";
import { projectMessages } from "./projection.ts";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const STATUS: Record<string, SubagentInfo["status"]> = {
  running: "running",
  idle: "done",
  parked: "done",
  aborted: "error",
};

/** 子代理的会话文件、产出和结构化结果都落在这个目录。 */
export function subagentDir(sessionId: string): string {
  return join(paths.sessions, sessionId, "subagents");
}

const STATUS_FILE = "status.json";

const infos = new Map<string, Map<string, SubagentInfo>>();

function infosOf(sessionId: string): Map<string, SubagentInfo> {
  const existing = infos.get(sessionId);
  if (existing !== undefined) return existing;
  const created = new Map<string, SubagentInfo>();
  infos.set(sessionId, created);
  return created;
}

async function persist(sessionId: string): Promise<void> {
  const rows = [...infosOf(sessionId).values()];
  await withLock(`subagents:${sessionId}`, () => writeJson(join(subagentDir(sessionId), STATUS_FILE), rows));
}

/** 进程内是真相，status.json 只给重放和服务重启兜底。 */
export function noteSubagent(sessionId: string, info: SubagentInfo): void {
  const map = infosOf(sessionId);
  map.set(info.agentId, { ...map.get(info.agentId), ...info });
  void persist(sessionId).catch(() => undefined);
}

async function hydrate(sessionId: string): Promise<Map<string, SubagentInfo>> {
  const map = infosOf(sessionId);
  if (map.size > 0) return map;
  const rows = await readJson<SubagentInfo[]>(join(subagentDir(sessionId), STATUS_FILE));
  if (Array.isArray(rows)) {
    for (const row of rows) if (typeof row?.agentId === "string") map.set(row.agentId, row);
  }
  return map;
}

export async function loadSubagents(sessionId: string): Promise<SubagentInfo[]> {
  return [...(await hydrate(sessionId)).values()];
}

export async function loadSubagentInfo(sessionId: string, agentId: string): Promise<SubagentInfo | undefined> {
  return (await hydrate(sessionId)).get(agentId);
}

/** details 里的快照是会话重放后唯一还在的运行信息。 */
export function infoOf(details: unknown, agentId: string): SubagentInfo | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const info = (details as { subagent?: SubagentInfo }).subagent;
  return info !== undefined && info.agentId === agentId ? info : undefined;
}

export async function subagentTranscript(
  sessionId: string,
  agentId: string,
  offset: number,
): Promise<SubagentTranscript> {
  if (!AGENT_ID.test(agentId)) throw new HttpError(400, "子代理 ID 非法", "invalid_agent_id");
  const ref = AgentRegistry.global().get(agentId);
  const session = ref?.session;
  const live = session == null ? undefined : [...session.agent.state.messages];
  const messages =
    live !== undefined && live.length > 0
      ? live
      : await messagesFromFile(join(subagentDir(sessionId), `${agentId}.jsonl`));
  const items: ChatItem[] = projectMessages(messages, session?.agent.state.pendingToolCalls);
  const info = await loadSubagentInfo(sessionId, agentId);
  const status = ref === undefined ? info?.status : STATUS[ref.status];
  const activity = ref?.activity ?? info?.activity;
  const partial = session?.agent.state.streamMessage ?? null;
  let streamChars = 0;
  if (partial?.role === "assistant") {
    for (const block of partial.content) {
      if (block.type === "text") streamChars += block.text.length;
      else if (block.type === "thinking") streamChars += block.thinking.length;
    }
  }
  return {
    items: items.slice(Math.max(0, offset)),
    total: items.length,
    live: live !== undefined && live.length > 0,
    streaming: session?.isStreaming ?? false,
    streamChars,
    ...(status === undefined ? {} : { status }),
    ...(activity === undefined ? {} : { activity }),
    ...(info?.percent === undefined ? {} : { percent: info.percent }),
    ...(info?.stage === undefined ? {} : { stage: info.stage }),
    ...(info?.watch === undefined ? {} : { watch: info.watch }),
    ...(info?.probeCost === undefined ? {} : { probeCost: info.probeCost }),
    ...(info?.tokens === undefined ? {} : { tokens: info.tokens }),
    ...(info?.toolCount === undefined ? {} : { toolCount: info.toolCount }),
    ...(info?.durationMs === undefined ? {} : { durationMs: info.durationMs }),
    ...(ref?.createdAt === undefined ? {} : { startedAt: ref.createdAt }),
  };
}

/** 只中止这个子代理的会话；父 turn 继续，delegate 按失败返回。 */
export function stopSubagent(agentId: string): boolean {
  if (!AGENT_ID.test(agentId)) return false;
  const ref = AgentRegistry.global().get(agentId);
  if (ref?.status !== "running" || ref.session === null) return false;
  void ref.session.abort({ reason: "用户停止了子代理" });
  return true;
}
