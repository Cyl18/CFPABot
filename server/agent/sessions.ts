import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ReviewDraft, SessionStatus, SessionSummary } from "../../shared/api.ts";
import { paths } from "../paths.ts";
import { readJson, withLock, writeJson } from "../store.ts";
import type { Pack } from "./pack.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface SessionMeta {
  id: string;
  title: string;
  prNumber?: number;
  status: SessionStatus;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  source: "web" | "github";
  model: string;
  hasDraft: boolean;
  review: boolean;
  lastError?: string;
  baseSha?: string;
  headSha?: string;
  stale?: boolean;
}

export interface SessionRecord {
  meta: SessionMeta;
  messages: AgentMessage[];
  draft?: ReviewDraft;
  pack?: Pack;
}

const draftCommentSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number(),
  key: z.string(),
  severity: z.enum(["critical", "major", "minor", "neutral"]),
  mqm: z.string(),
  en: z.string().optional(),
  zh: z.string().optional(),
  body: z.string(),
  suggestion: z.string().optional(),
  covers: z.array(z.string()).optional(),
  suspected: z.boolean().optional(),
});

const draftSchema = z.object({
  prNumber: z.number(),
  headSha: z.string(),
  verdict: z.enum(["approve", "changes", "reject"]),
  summary: z.string(),
  comments: z.array(draftCommentSchema),
  updatedAt: z.string(),
  publishedAt: z.string().optional(),
  publishedUrl: z.string().optional(),
});

const metaSchema = z.object({
  id: z.string(),
  title: z.string(),
  prNumber: z.number().optional(),
  status: z.enum(["idle", "running"]),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  source: z.enum(["web", "github"]),
  model: z.string(),
  hasDraft: z.boolean().default(false),
  review: z.boolean().default(false),
  lastError: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  stale: z.boolean().optional(),
});

const recordSchema = z.object({
  meta: metaSchema,
  messages: z.array(z.unknown()).default([]),
  draft: draftSchema.optional(),
  pack: z.unknown().optional(),
});

function isMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object" || !("role" in value)) return false;
  const role = value.role;
  return role === "system" || role === "user" || role === "assistant" || role === "toolResult";
}

function isPack(value: unknown): value is Pack {
  if (!value || typeof value !== "object") return false;
  if (!("prNumber" in value) || typeof value.prNumber !== "number") return false;
  if (!("headSha" in value) || typeof value.headSha !== "string") return false;
  return "workspaces" in value && Array.isArray(value.workspaces);
}

function toRecord(parsed: z.infer<typeof recordSchema>): SessionRecord {
  const messages: AgentMessage[] = [];
  for (const item of parsed.messages) if (isMessage(item)) messages.push(item);
  const record: SessionRecord = { meta: parsed.meta, messages };
  if (parsed.draft) record.draft = parsed.draft;
  if (isPack(parsed.pack)) record.pack = parsed.pack;
  return record;
}

export function summarize(record: SessionRecord): SessionSummary {
  const meta = record.meta;
  return {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    archived: meta.archived,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    createdBy: meta.createdBy,
    model: meta.model,
    hasDraft: Boolean(record.draft),
    ...(meta.prNumber !== undefined ? { prNumber: meta.prNumber } : {}),
    ...(meta.lastError ? { lastError: meta.lastError } : {}),
  };
}

export class SessionStore {
  private records = new Map<string, SessionRecord>();

  async init(): Promise<void> {
    await mkdir(paths.sessions, { recursive: true });
    const entries = await readdir(paths.sessions, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.read(entry.name.slice(0, -5));
      if (!record || record.meta.status !== "running") continue;
      record.meta.status = "idle";
      record.meta.lastError = "服务重启，运行中的会话已中止";
      record.meta.updatedAt = new Date().toISOString();
      await this.put(record);
    }
  }

  peek(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  all(): SessionRecord[] {
    return [...this.records.values()];
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.records.get(id) ?? (await this.read(id));
  }

  async put(record: SessionRecord): Promise<void> {
    this.records.set(record.meta.id, record);
    await withLock(`session:${record.meta.id}`, () =>
      writeJson(join(paths.sessions, `${record.meta.id}.json`), record),
    );
  }

  private async read(id: string): Promise<SessionRecord | null> {
    if (!ID_PATTERN.test(id)) return null;
    const raw = await readJson<unknown>(join(paths.sessions, `${id}.json`));
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) return null;
    const record = toRecord(parsed.data);
    this.records.set(id, record);
    return record;
  }
}
