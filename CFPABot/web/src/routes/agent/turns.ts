import type { ChatItem } from "@cfpa/contracts/api";

export type UserItem = Extract<ChatItem, { kind: "user" }>;
export type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;
export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** 一次 POST 触发的整段运行 = 回合（turn）；其中每次模型往返 = 步（step）。 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
}

export interface Step {
  key: string;
  at: string;
  text: string;
  thinking?: string;
  completedAt?: string;
  tools: ToolItem[];
}

export interface Turn {
  key: string;
  index: number;
  user?: UserItem;
  steps: Step[];
  answer?: AssistantItem;
  usage: UsageTotals;
  startedAt: string;
  endedAt: string;
  /** 仅在有可信结束时刻（工具时间戳或响应完成时刻）时给出。 */
  elapsed?: number;
  running: boolean;
}

function addUsage(target: UsageTotals, item: AssistantItem): void {
  const usage = item.usage;
  if (usage === undefined) return;
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.cost += usage.cost ?? 0;
  target.contextTokens = Math.max(target.contextTokens, usage.contextTokens);
}

export function buildTurns(items: readonly ChatItem[], running: boolean): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | undefined;

  const open = (at: string, user?: UserItem): Turn => {
    const created: Turn = {
      key: user?.id ?? `turn-${turns.length}`,
      index: turns.length + 1,
      ...(user !== undefined ? { user } : {}),
      steps: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      startedAt: at,
      endedAt: at,
      running: false,
    };
    turns.push(created);
    return created;
  };

  for (const item of items) {
    if (item.kind === "user") {
      turn = open(item.at, item);
      continue;
    }
    turn ??= open(item.at);
    turn.endedAt = item.at;
    if (item.kind === "assistant") {
      turn.steps.push({
        key: item.id,
        at: item.at,
        text: item.text,
        ...(item.thinking !== undefined ? { thinking: item.thinking } : {}),
        ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
        tools: [],
      });
      addUsage(turn.usage, item);
      continue;
    }
    const step = turn.steps.at(-1);
    if (step === undefined) turn.steps.push({ key: `step-${item.id}`, at: item.at, text: "", tools: [item] });
    else step.tools.push(item);
  }

  for (const [index, entry] of turns.entries()) {
    let lastTool = -1;
    entry.steps.forEach((step, position) => {
      if (step.tools.length > 0) lastTool = position;
    });
    let lastKnown = 0;
    for (const step of entry.steps) {
      for (const tool of step.tools) {
        const time = Date.parse(tool.at);
        if (Number.isFinite(time)) lastKnown = Math.max(lastKnown, time);
      }
      const done = Date.parse(step.completedAt ?? "");
      if (Number.isFinite(done)) lastKnown = Math.max(lastKnown, done);
    }
    const began = Date.parse(entry.startedAt);
    entry.elapsed = lastKnown > 0 && Number.isFinite(began) ? Math.max(0, lastKnown - began) : undefined;

    // 最后一段正文之后没有工具调用时，它才是这一轮的答案；否则仍在过程里。
    for (let position = entry.steps.length - 1; position > lastTool; position -= 1) {
      const step = entry.steps[position];
      if (step === undefined || step.text.trim() === "") continue;
      const assistant = items.find((item): item is AssistantItem => item.kind === "assistant" && item.id === step.key);
      if (assistant === undefined) continue;
      entry.answer = assistant;
      entry.steps.splice(position, 1);
    }
    entry.steps = entry.steps.filter(
      (step) => step.text.trim() !== "" || (step.thinking?.trim() ?? "") !== "" || step.tools.length > 0,
    );
    entry.running = running && index === turns.length - 1;
  }

  return turns;
}

export function formatTokens(value: number): string {
  if (value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const k = value / 1000;
  if (k < 100) return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  if (k < 1000) return `${Math.round(k)}k`;
  return `${(k / 1000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function turnElapsed(turn: Turn, now: number): number | undefined {
  if (!turn.running) return turn.elapsed;
  const began = Date.parse(turn.startedAt);
  return Number.isFinite(began) ? Math.max(0, now - began) : undefined;
}

/** 缓存命中率：命中的 prompt token 占全部 prompt token。 */
export function cacheRatio(usage: UsageTotals): number {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? usage.cacheRead / prompt : 0;
}
