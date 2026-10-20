import { readdirSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { EvalScope, SessionStatus, SessionSummary, WriteScope } from "../../shared/api.ts";
import { paths } from "../paths.ts";
import { readJson, withLock, writeJson } from "../store.ts";
import { localDir } from "./local-store.ts";

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
  writeScope: WriteScope;
  evalScope: EvalScope;
  review: boolean;
  lastError?: string;
  baseSha?: string;
  headSha?: string;
}

export interface SessionRecord {
  meta: SessionMeta;
  sessionFile?: string;
}

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
  writeScope: z.enum(["off", "on"]).default("off"),
  evalScope: z.enum(["off", "run"]).default("off"),
  review: z.boolean().default(false),
  lastError: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
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

export function summarize(record: SessionRecord): SessionSummary {
  const meta = record.meta;
  let hasDraft = false;
  try {
    const names = readdirSync(localDir(meta.id)) as string[];
    hasDraft = names.some((name) => name.endsWith(".json"));
  } catch {
    // local 目录还没建
  }
  return {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    archived: meta.archived,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    createdBy: meta.createdBy,
    model: meta.model,
    hasDraft,
    writeScope: meta.writeScope,
    evalScope: meta.evalScope,
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
