import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SCOPES } from "@cfpa/contracts/api";
import type {
  Scope,
  SessionDraftSummary,
  SessionStatus,
  SessionSummary,
  ThinkingLevel,
} from "@cfpa/contracts/api";
import { paths } from "../paths.ts";
import { readJson, withLock, writeJson } from "../store.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface SessionMeta {
  id: string;
  title: string;
  status: SessionStatus;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  source: "web" | "github";
  model: string;
  writeScope: Scope;
  evalScope: Scope;
  bashScope: Scope;
  thinking?: ThinkingLevel;
  prNumber?: number;
  lastError?: string;
}

export interface SessionRecord {
  meta: SessionMeta;
  sessionFile?: string;
}

const metaSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["idle", "running"]),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  source: z.enum(["web", "github"]),
  model: z.string(),
  writeScope: z.enum(SCOPES).default("off"),
  evalScope: z.enum(SCOPES).default("off"),
  bashScope: z.enum(SCOPES).default("off"),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  prNumber: z.number().int().positive().optional(),
  lastError: z.string().optional(),
});

const recordSchema = z.object({
  meta: metaSchema,
  sessionFile: z.string().optional(),
});

function toRecord(parsed: z.infer<typeof recordSchema>): SessionRecord {
  const record: SessionRecord = { meta: parsed.meta };
  if (parsed.sessionFile) record.sessionFile = parsed.sessionFile;
  return record;
}

export function summarize(
  record: SessionRecord,
  hasArtifact: boolean,
  draft?: SessionDraftSummary,
): SessionSummary {
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
    ...(meta.prNumber !== undefined ? { prNumber: meta.prNumber } : {}),
    hasArtifact,
    ...(draft ? { draft } : {}),
    writeScope: meta.writeScope,
    evalScope: meta.evalScope,
    bashScope: meta.bashScope,
    ...(meta.thinking !== undefined ? { thinking: meta.thinking } : {}),
    ...(meta.lastError ? { lastError: meta.lastError } : {}),
  };
}

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  private pending = new Map<string, Promise<SessionRecord | null>>();

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
    const cached = this.records.get(id);
    if (cached) return cached;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const read = this.read(id).finally(() => this.pending.delete(id));
    this.pending.set(id, read);
    return read;
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
