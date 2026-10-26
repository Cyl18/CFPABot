import type { ChatItem, SubagentInfo, TodoPhase, TodoStatus, TodoTask, ToolCallView } from "@cfpa/contracts/api";
import { TODO_STATUSES } from "@cfpa/contracts/api";
import { isRecord } from "@/lib/guards.ts";

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export function stringArg(tool: ToolCallView, key: string): string | undefined {
  const args = isRecord(tool.args) ? tool.args : null;
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

function isTaskStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.some((status) => status === value);
}

function parseTask(value: unknown): TodoTask | undefined {
  if (!isRecord(value) || typeof value.content !== "string" || !isTaskStatus(value.status)) return undefined;
  return {
    content: value.content,
    status: value.status,
    ...(typeof value.blocker === "string" ? { blocker: value.blocker } : {}),
  };
}

export function todoPhases(details: unknown): TodoPhase[] | undefined {
  if (!isRecord(details) || !Array.isArray(details.phases)) return undefined;
  const phases: TodoPhase[] = [];
  for (const raw of details.phases) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !Array.isArray(raw.tasks)) continue;
    phases.push({
      name: raw.name,
      tasks: raw.tasks.map(parseTask).filter((task): task is TodoTask => task !== undefined),
    });
  }
  return phases;
}

export function planStats(phases: readonly TodoPhase[] | undefined): { total: number; completed: number; active: number; blocked: number } {
  let total = 0;
  let completed = 0;
  let active = 0;
  let blocked = 0;
  for (const phase of phases ?? []) {
    for (const task of phase.tasks) {
      total += 1;
      if (task.status === "completed") completed += 1;
      else if (task.status === "in_progress") active += 1;
      else if (task.status === "blocked") blocked += 1;
    }
  }
  return { total, completed, active, blocked };
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveFilePath(raw: string, prNumber: number | undefined): string | null {
  const clean = (raw.split("?")[0] ?? "").split("#")[0]?.replaceAll("\\", "/") ?? "";
  if (clean.startsWith("skill://") || clean.startsWith("local://") || clean.startsWith("gh://")) {
    return null;
  }
  if (prNumber !== undefined) {
    const prefix = `pr://${prNumber}/files/`;
    if (clean.startsWith(prefix)) return safeDecode(clean.slice(prefix.length).replace(/:\d+(?:-\d+)?$/, ""));
    const marker = `/runtime/work/pr/${prNumber}/`;
    const index = clean.indexOf(marker);
    if (index >= 0) return safeDecode(clean.slice(index + marker.length).replace(/:\d+(?:-\d+)?$/, ""));
  }
  if (clean.startsWith("pr://")) return null;
  if (clean.startsWith("repo://")) return clean.slice("repo://".length);
  const repoMarker = "/runtime/work/repo/";
  const repoIndex = clean.indexOf(repoMarker);
  if (repoIndex >= 0) return clean.slice(repoIndex + repoMarker.length);
  return clean.replace(/^\/+/, "");
}

export function delegateItems(items: readonly ChatItem[]): ToolItem[] {
  return items.filter((item): item is ToolItem => item.kind === "tool" && item.tool.name === "delegate");
}

export function subagentModel(tool: ToolCallView): string | undefined {
  const details = isRecord(tool.details) ? tool.details : null;
  if (typeof details?.model === "string") return details.model;
  return stringArg(tool, "model")?.replace(/^@/, "");
}

const SUBAGENT_STATUS: Record<string, SubagentInfo["status"]> = {
  queued: "queued",
  running: "running",
  done: "done",
  error: "error",
};

/** delegate 结果里的快照：刷新后只有它还能说明这个子代理跑过什么。 */
export function subagentInfo(tool: ToolCallView): SubagentInfo | undefined {
  const details = isRecord(tool.details) ? tool.details : null;
  const raw = details !== null && isRecord(details.subagent) ? details.subagent : null;
  if (raw === null || typeof raw.agentId !== "string" || typeof raw.agent !== "string") return undefined;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const model = typeof raw.model === "string" ? raw.model : undefined;
  const activity = typeof raw.activity === "string" ? raw.activity : undefined;
  const currentTool = typeof raw.currentTool === "string" ? raw.currentTool : undefined;
  const startMs = typeof raw.currentToolStartMs === "number" ? raw.currentToolStartMs : undefined;
  const contextTokens = typeof raw.contextTokens === "number" ? raw.contextTokens : undefined;
  const contextWindow = typeof raw.contextWindow === "number" ? raw.contextWindow : undefined;
  return {
    agentId: raw.agentId,
    agent: raw.agent,
    status: typeof raw.status === "string" ? (SUBAGENT_STATUS[raw.status] ?? "queued") : "queued",
    ...(model === undefined ? {} : { model }),
    ...(activity === undefined ? {} : { activity }),
    toolCount: number(raw.toolCount),
    tokens: number(raw.tokens),
    cost: number(raw.cost),
    durationMs: number(raw.durationMs),
    ...(currentTool === undefined ? {} : { currentTool }),
    ...(startMs === undefined ? {} : { currentToolStartMs: startMs }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}
