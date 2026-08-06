// src/agent/session-projection.ts
// Sole home of projectToSse (SSE event projection). No SessionRecord writes.
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

interface ProjectableMessage {
  role?: unknown;
  content?: unknown;
  timestamp?: number | string;
  toolName?: string;
}

function isProjectableMessage(x: unknown): x is ProjectableMessage {
  return !!x && typeof x === "object";
}

/** Project AgentSessionEvent to SSE event format for frontend. */
export function projectToSse(event: AgentSessionEvent, sessionId: string): Record<string, unknown> | null {
  switch (event.type) {
    case "message_end": {
      if (!isProjectableMessage(event.message)) return null;
      const msg = event.message as ProjectableMessage;
      const ts = typeof msg.timestamp === "number"
        ? new Date(msg.timestamp).toISOString()
        : typeof msg.timestamp === "string"
          ? msg.timestamp
          : new Date().toISOString();
      const thinking = extractThinkingText(msg);
      const message: Record<string, unknown> = {
        role: msg.role,
        content: extractContentForSse(msg),
        timestamp: ts,
      };
      if (thinking !== undefined) message.thinking = thinking;
      // Include toolName for toolResult role so FE can display which tool produced the result
      if (msg.role === "toolResult" && typeof msg.toolName === "string") {
        message.toolName = msg.toolName;
      }
      return {
        type: "message_end",
        sessionId,
        timestamp: ts,
        message,
      };
    }
    case "agent_start":
      return { type: "agent_start", sessionId };
    case "agent_settled":
      return { type: "agent_settled", sessionId };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
      };
    case "tool_execution_update":
      // 透传 tool 执行进度(如 review_moa 的 batch 进度), 前端据此渲染进度条。
      return {
        type: "tool_execution_update",
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        partialResult: event.partialResult,
      };
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_update":
    case "agent_end":
    case "compaction_start":
    case "compaction_end":
    case "thinking_level_changed":
    case "queue_update":
    case "auto_retry_start":
    case "auto_retry_end":
      return null;
    default:
      return null;
  }
}

function extractContentForSse(msg: unknown): string | unknown[] {
  if (!isProjectableMessage(msg)) return "";
  if (!("content" in msg)) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlocks = content.filter(
      (c: unknown) => c && typeof c === "object" && (c as Record<string, unknown>).type === "text",
    );
    if (textBlocks.length > 0 && textBlocks.length === content.length) {
      return textBlocks.map((c: unknown) => (c as Record<string, unknown>).text).join("\n");
    }
    return content;
  }
  return "";
}

/** Extract joined thinking text from a pi-agent message (ThinkingContent blocks). */
function extractThinkingText(msg: ProjectableMessage): string | undefined {
  const content = msg.content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block) {
      const b = block as Record<string, unknown>;
      if (b.type === "thinking" && typeof b.thinking === "string") {
        parts.push(b.thinking);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
