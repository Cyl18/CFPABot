// src/agent/pi-transcript-reader.ts
// Read pi-coding-agent JSONL transcripts and project them to the flat
// SessionMessage-compatible shape used by the API / frontend.
//
// After Phase 2, the pi coding agent JSONL is the sole conversation truth;
// SessionRecord.messages is a metadata breadcrumb only, so history is served
// through this reader via GET /sessions/:sessionId/messages.

import { resolve, normalize, join } from "node:path";
import { readFile } from "node:fs/promises";
import type { SessionMessage } from "./session-types.js";
import { SESSIONS_TRANSCRIPTS_DIR } from "../runtime-paths.js";

const PI_SESSIONS_PREFIX = normalize(resolve(SESSIONS_TRANSCRIPTS_DIR)).replace(/\\/g, "/") + "/";

interface ProjectableMessage {
  role?: unknown;
  content?: unknown;
  timestamp?: number | string;
  toolName?: string;
}

/** Extract joined text content from a pi-agent message. */
export function extractContentText(msg: ProjectableMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        }
      }
    }
    if (textParts.length === 0) {
      if (msg.role === "assistant") return "[assistant response]";
      if (msg.role === "toolResult") {
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
        return `[tool result: ${toolName}]`;
      }
    }
    return textParts.join("\n");
  }
  return "";
}

/** Extract joined thinking text from a pi-agent message (ThinkingContent blocks). */
export function extractThinkingText(msg: ProjectableMessage): string | undefined {
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

/**
 * Assert that a transcript path resides under the transcripts directory.
 * Same rule as session-manager: path must be inside SESSIONS_TRANSCRIPTS_DIR.
 * Returns the absolute resolved path.
 */
function safeTranscriptAbs(piSessionFile: string): string {
  const cwd = process.cwd();
  const requested = resolve(join(cwd, piSessionFile));
  const normalizedReq = normalize(requested).replace(/\\/g, "/");
  if (!normalizedReq.startsWith(PI_SESSIONS_PREFIX)) {
    throw new Error(
      `Invalid piSessionFile path: ${piSessionFile} — must reside under ${SESSIONS_TRANSCRIPTS_DIR}`,
    );
  }
  return requested;
}

/** Parse a pi-coding-agent JSONL file into flat SessionMessage-compatible messages. */
function parseTranscript(content: string): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    // pi-agent JSONL v3 wraps each message under a `message` key
    // ({"type":"message", ..., "message":{"role":...}}); other record
    // types (session/model_change/...) carry no message payload.
    const m = parsed as ProjectableMessage & { message?: ProjectableMessage };
    const msg = m.message ?? m;
    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "system") continue;
    const contentText = extractContentText(msg);
    if (role === "assistant" && contentText === "") continue;
    const rawTs = m.timestamp ?? msg.timestamp;
    const ts =
      typeof rawTs === "number"
        ? new Date(rawTs).toISOString()
        : typeof rawTs === "string"
          ? rawTs
          : new Date().toISOString();
    const thinking = extractThinkingText(msg);
    const entry: SessionMessage = {
      role: role === "toolResult" ? "tool" : (role as string),
      content: contentText,
      timestamp: ts,
    };
    if (thinking !== undefined) entry.thinking = thinking;
    if (role === "toolResult" && typeof msg.toolName === "string") {
      entry.toolName = msg.toolName;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Read pi JSONL via SessionRecord.piSessionFile, returning a flat
 * SessionMessage-compatible array. Path safety: only under transcripts dir.
 * Missing / unreadable file → [].
 */
export async function readTranscriptMessages(piSessionFile: string | undefined): Promise<SessionMessage[]> {
  if (!piSessionFile) return [];
  let abs: string;
  try {
    abs = safeTranscriptAbs(piSessionFile);
  } catch {
    return [];
  }
  try {
    return parseTranscript(await readFile(abs, "utf-8"));
  } catch {
    return [];
  }
}

/** Count messages in a transcript file without materializing the array. */
export async function countTranscriptMessages(piSessionFile: string | undefined): Promise<number> {
  if (!piSessionFile) return 0;
  let abs: string;
  try {
    abs = safeTranscriptAbs(piSessionFile);
  } catch {
    return 0;
  }
  try {
    // 只按非空行计数,不做 JSON.parse — 避免全量解析的开销
    const content = await readFile(abs, "utf-8");
    let count = 0;
    for (const raw of content.split("\n")) {
      if (raw.trim()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}
