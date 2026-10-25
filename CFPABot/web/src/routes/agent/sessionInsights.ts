import type { ChatItem, PrFile, ToolCallView } from "@cfpa/contracts/api";
import { isRecord } from "@/lib/guards.ts";

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const TASK_STATUSES = ["pending", "in_progress", "completed", "abandoned", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TodoTask {
  content: string;
  status: TaskStatus;
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: readonly TodoTask[];
}

export interface FileEntry {
  path: string;
  reads: number;
  reviewed: boolean;
}

export interface FileProgress {
  total: number;
  read: number;
  reviewed: number;
  totalReads: number;
  entries: FileEntry[];
}

export function stringArg(tool: ToolCallView, key: string): string | undefined {
  const args = isRecord(tool.args) ? tool.args : null;
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.some((status) => status === value);
}

function parseTask(value: unknown): TodoTask | null {
  if (!isRecord(value) || typeof value.content !== "string" || !isTaskStatus(value.status)) return null;
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
      tasks: raw.tasks.map(parseTask).filter((task): task is TodoTask => task !== null),
    });
  }
  return phases;
}

/** 最后一次成功的 todo 快照就是当前计划；失败调用沿用上一份。 */
export function parsePlan(items: readonly ChatItem[]): TodoPhase[] | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "tool" || item.tool.name !== "todo" || item.tool.state === "error") continue;
    const phases = todoPhases(item.tool.details);
    if (phases !== undefined) return phases;
  }
  return undefined;
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

function resolveFilePath(raw: string, prNumber: number | undefined): string | null {
  const clean = (raw.split("?")[0] ?? "").split("#")[0]?.replaceAll("\\", "/") ?? "";
  if (clean.startsWith("skill://") || clean.startsWith("local://") || clean.startsWith("gh://")) {
    return null;
  }
  if (prNumber !== undefined) {
    const prefix = `pr://${prNumber}/files/`;
    if (clean.startsWith(prefix)) return decodeURIComponent(clean.slice(prefix.length));
    const marker = `/runtime/work/pr/${prNumber}/`;
    const index = clean.indexOf(marker);
    if (index >= 0) return decodeURIComponent(clean.slice(index + marker.length));
  }
  if (clean.startsWith("pr://")) return null;
  if (clean.startsWith("repo://")) return clean.slice("repo://".length);
  const repoMarker = "/runtime/work/repo/";
  const repoIndex = clean.indexOf(repoMarker);
  if (repoIndex >= 0) return clean.slice(repoIndex + repoMarker.length);
  return clean.replace(/^\/+/, "");
}

function matchKnown(candidate: string, known: Set<string>): string | null {
  if (known.has(candidate)) return candidate;
  for (const path of known) {
    if (candidate.endsWith(`/${path}`)) return path;
  }
  return null;
}

function reviewedFromPlan(phases: readonly TodoPhase[] | undefined, known: Set<string>): Set<string> {
  const reviewed = new Set<string>();
  if (phases === undefined) return reviewed;
  const longestFirst = [...known].sort((left, right) => right.length - left.length);
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status !== "completed") continue;
      const content = task.content.replaceAll("\\", "/");
      const match = longestFirst.find((path) => content.includes(path));
      if (match !== undefined) reviewed.add(match);
    }
  }
  return reviewed;
}

/** `read` 命中的 PR 文件算已读；todo 里完成的文件才算已审。 */
export function fileProgress(items: readonly ChatItem[], files: readonly PrFile[], prNumber: number | undefined): FileProgress {
  const known = new Set(files.map((file) => file.path));
  const reads = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool" || item.tool.name !== "read" || item.tool.state === "error") continue;
    const raw = stringArg(item.tool, "path");
    if (raw === undefined) continue;
    const resolved = resolveFilePath(raw, prNumber);
    if (resolved === null) continue;
    const matched = known.size > 0 ? matchKnown(resolved, known) : resolved;
    if (matched === null) continue;
    reads.set(matched, (reads.get(matched) ?? 0) + 1);
  }
  const reviewed = reviewedFromPlan(parsePlan(items), known);
  const entries: FileEntry[] =
    files.length > 0
      ? files.map((file) => ({ path: file.path, reads: reads.get(file.path) ?? 0, reviewed: reviewed.has(file.path) }))
      : [...reads].map(([path, count]) => ({ path, reads: count, reviewed: reviewed.has(path) }));
  return {
    total: files.length,
    read: files.length > 0 ? files.filter((file) => reads.has(file.path)).length : reads.size,
    reviewed: reviewed.size,
    totalReads: [...reads.values()].reduce((sum, count) => sum + count, 0),
    entries,
  };
}

export function delegateItems(items: readonly ChatItem[]): ToolItem[] {
  return items.filter((item): item is ToolItem => item.kind === "tool" && item.tool.name === "delegate");
}

export function subagentModel(tool: ToolCallView): string | undefined {
  const details = isRecord(tool.details) ? tool.details : null;
  if (typeof details?.model === "string") return details.model;
  return stringArg(tool, "model")?.replace(/^@/, "");
}
