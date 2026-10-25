import { join } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ChatItem, SubagentInfo, SubagentTranscript } from "@cfpa/contracts/api";
import { HttpError } from "../errors.ts";
import { paths } from "../paths.ts";
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
  const items: ChatItem[] = projectMessages(messages);
  const status = ref === undefined ? undefined : STATUS[ref.status];
  return {
    items: items.slice(Math.max(0, offset)),
    total: items.length,
    live: live !== undefined && live.length > 0,
    ...(status === undefined ? {} : { status }),
    ...(ref?.activity === undefined ? {} : { activity: ref.activity }),
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
