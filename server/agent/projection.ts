import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatItem, ToolCallView } from "../../shared/api.ts";

const RESULT_LIMIT = 2000;
const STREAM_THROTTLE_MS = 150;

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object");
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of blocksOf(content)) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function thinkingOf(content: unknown): string | undefined {
  const parts: string[] = [];
  for (const block of blocksOf(content)) {
    if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function truncate(text: string): string {
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…[结果已截断]` : text;
}

function isoAt(timestamp: unknown): string {
  return typeof timestamp === "number" ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function toolItem(
  id: string,
  name: string,
  args: unknown,
  state: ToolCallView["state"],
  extra?: { progress?: string; result?: string; at?: string },
): ChatItem {
  return {
    id,
    kind: "tool",
    at: extra?.at ?? new Date().toISOString(),
    tool: {
      name,
      args,
      state,
      ...(extra?.progress ? { progress: extra.progress } : {}),
      ...(extra?.result ? { result: extra.result } : {}),
    },
  };
}

function toolCallsOf(content: unknown): { id: string; name: string; args: unknown }[] {
  const calls: { id: string; name: string; args: unknown }[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "toolCall") continue;
    const id = typeof block.id === "string" ? block.id : "";
    const name = typeof block.name === "string" ? block.name : "";
    if (!id || !name) continue;
    calls.push({ id, name, args: block.arguments });
  }
  return calls;
}

function assistantItem(index: number, message: AgentMessage, streaming: boolean): ChatItem | null {
  if (message.role !== "assistant") return null;
  const text = textOf(message.content);
  const thinking = thinkingOf(message.content);
  if (!text && !thinking) return null;
  return {
    id: `m${index}`,
    kind: "assistant",
    text,
    ...(thinking ? { thinking } : {}),
    at: isoAt(message.timestamp),
    ...(streaming ? { streaming: true } : {}),
  };
}

export function projectMessages(messages: AgentMessage[]): ChatItem[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    results.set(message.toolCallId, { text: truncate(textOf(message.content)), isError: message.isError });
  }
  const items: ChatItem[] = [];
  messages.forEach((message, index) => {
    const at = isoAt(message.timestamp);
    if (message.role === "user") {
      items.push({ id: `m${index}`, kind: "user", text: textOf(message.content), at });
      return;
    }
    if (message.role !== "assistant") return;
    const assistant = assistantItem(index, message, false);
    if (assistant) items.push(assistant);
    for (const call of toolCallsOf(message.content)) {
      const result = results.get(call.id);
      items.push(
        toolItem(call.id, call.name, call.args, result ? (result.isError ? "error" : "done") : "pending", {
          at,
          ...(result ? { result: result.text } : {}),
        }),
      );
    }
  });
  return items;
}

export class LiveProjector {
  private nextIndex: number;
  private currentIndex = 0;
  private lastStreamAt = 0;
  private toolArgs = new Map<string, unknown>();

  constructor(startIndex: number) {
    this.nextIndex = startIndex;
  }

  handle(event: AgentEvent): ChatItem[] {
    switch (event.type) {
      case "message_start":
        this.currentIndex = this.nextIndex++;
        return [];
      case "message_update": {
        if (event.message.role !== "assistant") return [];
        const now = Date.now();
        if (now - this.lastStreamAt < STREAM_THROTTLE_MS) return [];
        this.lastStreamAt = now;
        const item = assistantItem(this.currentIndex, event.message, true);
        return item ? [item] : [];
      }
      case "message_end": {
        const index = this.currentIndex;
        if (event.message.role === "user") {
          return [{ id: `m${index}`, kind: "user", text: textOf(event.message.content), at: isoAt(event.message.timestamp) }];
        }
        if (event.message.role !== "assistant") return [];
        const out: ChatItem[] = [];
        const item = assistantItem(index, event.message, false);
        if (item) out.push(item);
        for (const call of toolCallsOf(event.message.content)) {
          this.toolArgs.set(call.id, call.args);
          out.push(toolItem(call.id, call.name, call.args, "pending", { at: isoAt(event.message.timestamp) }));
        }
        return out;
      }
      case "tool_execution_start":
        this.toolArgs.set(event.toolCallId, event.args);
        return [toolItem(event.toolCallId, event.toolName, event.args, "running")];
      case "tool_execution_update": {
        this.toolArgs.set(event.toolCallId, event.args);
        const progress = progressOf(event.partialResult);
        return [toolItem(event.toolCallId, event.toolName, event.args, "running", progress ? { progress } : {})];
      }
      case "tool_execution_end":
        return [
          toolItem(event.toolCallId, event.toolName, this.toolArgs.get(event.toolCallId), event.isError ? "error" : "done", {
            result: resultTextOf(event.result),
          }),
        ];
      default:
        return [];
    }
  }
}

function progressOf(partialResult: unknown): string | undefined {
  if (!partialResult || typeof partialResult !== "object" || !("details" in partialResult)) return undefined;
  const details = partialResult.details;
  if (!details || typeof details !== "object" || !("progress" in details)) return undefined;
  return typeof details.progress === "string" ? details.progress : undefined;
}

function resultTextOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  return truncate(textOf(result.content));
}
