import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createAgentSession,
  type AgentSession,
  type SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import type {
  CreateSessionRequest,
  EvalScope,
  ReviewDraft,
  SessionDetail,
  SessionEvent,
  SessionSummary,
  WriteScope,
} from "../../shared/api.ts";
import { prdata } from "../prdata.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { type ToolContext } from "./context.ts";
import { DRAFT_FILE, parseDraftFile, serializeDraftFile, validateDraft, type DraftContext } from "./draft.ts";
import { SessionHub } from "./events.ts";
import { loadConfig, llm, resolveModel, setModelForTest } from "./llm.ts";
import { reasoningOf } from "./llm-providers.ts";
import { isLocalPath, listLocal, localDir, readLocal, readLocalSync, writeLocal } from "./local-store.ts";
import { openSessionManager, sessionMessages } from "./pi.ts";
import { mqmTable } from "./mqm.ts";
import { LiveProjector, projectMessages } from "./projection.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { publishDraft } from "./publish.ts";
import { SessionStore, summarize, type SessionMeta, type SessionRecord } from "./sessions.ts";
import { buildTools } from "./tools/index.ts";

export { llm, setModelForTest };

const log = logger("agent");
const store = new SessionStore();
const hub = new SessionHub();
const runtimes = new Map<string, AgentSession>();
const runs = new Map<string, Promise<void>>();
const active = new Set<string>();
const pendingAborts = new Set<string>();
const abortRequested = new Set<string>();

const ALLOWED_TOOLS: Record<string, true> = {
  read: true,
  write: true,
  edit: true,
  grep: true,
  find: true,
  ls: true,
  glossary: true,
  todo: true,
  task: true,
  wait: true,
  web_search: true,
};

function httpError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), { status, ...(code === undefined ? {} : { code }) });
}

function now(): string {
  return new Date().toISOString();
}

function titleFor(review: boolean, prNumber: number | undefined, message: string | undefined): string {
  if (review && prNumber !== undefined) return `审查 PR #${prNumber}`;
  const head = message?.split(/\r?\n/)[0]?.trim();
  if (head) return head.slice(0, 60);
  return prNumber !== undefined ? `PR #${prNumber} 会话` : "新会话";
}

function firstPrompt(review: boolean, prNumber: number | undefined, message: string | undefined): string {
  if (review && prNumber !== undefined) {
    return [`审查 PR #${prNumber}`, message].filter(Boolean).join("\n\n");
  }
  return message || "请查看当前 PR，完成用户要求的操作（默认：理解并汇报 PR 内容）。";
}

async function detailOf(record: SessionRecord): Promise<SessionDetail> {
  const meta = record.meta;
  const draft = parseDraftFile(readLocalSync(record.meta.id, DRAFT_FILE)?.content);
  return {
    ...summarize(record),
    items: projectMessages(await sessionMessages(record)),
    ...(draft === null ? {} : { draft }),
    ...(meta.headSha ? { headSha: meta.headSha } : {}),
  };
}

function toolContext(record: SessionRecord): ToolContext {
  const id = record.meta.id;
  return {
    sessionId: id,
    prNumber: record.meta.prNumber ?? null,
    baseSha: record.meta.baseSha ?? null,
    headSha: record.meta.headSha ?? null,
    writeScope: record.meta.writeScope,
    evalScope: record.meta.evalScope,
    local: async (name) => readLocal(id, name),
    saveLocal: async (name, content) => {
      if (!isLocalPath(name)) {
        throw new Error("本地路径无效：只能是相对路径，不能含 .. 或绝对路径。");
      }
      const entry = await writeLocal(id, name, content);
      const current = await store.get(id);
      if (!current) throw new Error("会话不存在");
      current.meta.updatedAt = entry.updatedAt;
      await store.put(current);
      return entry;
    },
    listLocal: async () => listLocal(id),
  };
}

async function draftContext(prNumber: number): Promise<DraftContext> {
  const table = await mqmTable();
  const data = await prdata.files(prNumber).catch(() => null);
  const patches = new Map<string, string | undefined>((data?.files ?? []).map((file) => [file.path, file.patch]));
  return { mqmIds: table.ids, labels: table.labels, patches };
}

async function runTurn(id: string, prompt: string): Promise<void> {
  let error: string | undefined;
  let session: AgentSession | undefined;
  let sessionFile: string | undefined;
  let aborted = pendingAborts.has(id);
  pendingAborts.delete(id);
  try {
    const record = await store.get(id);
    if (!record) return;
    await mkdir(localDir(id), { recursive: true });
    if (process.platform !== "win32") {
      await chmod(dirname(localDir(id)), 0o711);
      await chmod(localDir(id), 0o777);
    }
    const systemPrompt = await buildSystemPrompt(record.meta.review);
    const { model, apiKey, endpoint } = await resolveModel(record.meta.model);
    const manager = await openSessionManager(record);
    sessionFile = manager.getSessionFile() ?? record.sessionFile;
    const entries: SessionEntry[] = manager.getEntries();
    const projector = new LiveProjector(entries.filter((entry) => entry.type === "message").length);
    const created = await createAgentSession({
      cwd: paths.root,
      agentDir: paths.piAgent,
      model,
      getApiKey: async () => apiKey,
      sessionManager: manager,
      customTools: buildTools(toolContext(record)),
      disableExtensionDiscovery: true,
      systemPrompt,
      ...(endpoint ? { thinkingLevel: reasoningOf(endpoint) } : {}),
    });
    session = created.session;
    runtimes.set(id, session);
    const exec = record.meta.evalScope === "run";
    await session.setActiveToolsByName(
      session.getActiveToolNames().filter(
        (name) => ALLOWED_TOOLS[name] === true || ((name === "eval" || name === "bash") && exec),
      ),
    );
    session.subscribe((event) => {
      for (const item of projector.handle(event)) hub.emit(id, { type: "item", item });
    });
    if (aborted || abortRequested.delete(id) || pendingAborts.delete(id)) {
      aborted = true;
      await session.abort();
      return;
    }
    await session.prompt(prompt);
    if (abortRequested.delete(id)) aborted = true;
    if (!aborted) {
      const last = session.agent.state.messages.at(-1);
      if (last?.role === "assistant" && last.errorMessage) error = last.errorMessage;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error("会话运行失败", { id, err });
  } finally {
    runtimes.delete(id);
    active.delete(id);
    await session?.dispose();
    const fresh = await store.get(id).catch(() => null);
    if (fresh) {
      if (sessionFile) fresh.sessionFile = sessionFile;
      fresh.meta.status = "idle";
      fresh.meta.updatedAt = now();
      if (error) fresh.meta.lastError = error;
      else delete fresh.meta.lastError;
      await store.put(fresh).catch((err: unknown) => log.error("会话状态写入失败", { id, err }));
    }
    hub.emit(id, { type: "status", status: "idle", ...(error ? { lastError: error } : {}) });
  }
}

async function launch(id: string, prompt: string): Promise<void> {
  active.add(id);
  try {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    record.meta.status = "running";
    record.meta.updatedAt = now();
    delete record.meta.lastError;
    await store.put(record);
    hub.emit(id, { type: "status", status: "running" });
  } catch (err) {
    active.delete(id);
    throw err;
  }
  const run = runTurn(id, prompt).catch((err: unknown) => {
    log.error("会话运行失败", { id, err });
  });
  runs.set(id, run);
  void run.finally(() => {
    if (runs.get(id) === run) runs.delete(id);
  });
}

export const agent = {
  async init(): Promise<void> {
    await store.init();
    log.info("会话索引已加载", { sessions: store.all().length });
  },

  async list(): Promise<SessionSummary[]> {
    return store
      .all()
      .map(summarize)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async get(id: string): Promise<SessionDetail | null> {
    const record = await store.get(id);
    return record ? await detailOf(record) : null;
  },

  async create(request: CreateSessionRequest & { createdBy: string; source: "web" | "github" }): Promise<SessionDetail> {
    const review = request.review === true && request.prNumber !== undefined;
    const message = request.message?.trim();
    if (!review && !message && request.prNumber === undefined) {
      throw httpError("需要提供 message，或设置 review 并给出 PR 编号", 400);
    }
    let baseSha: string | undefined;
    let headSha: string | undefined;
    if (request.prNumber !== undefined) {
      if (!Number.isInteger(request.prNumber) || request.prNumber <= 0) throw httpError("PR 编号非法", 400);
      const data = await prdata.files(request.prNumber).catch(() => null);
      if (!data) throw httpError(`无法获取 PR #${request.prNumber} 信息，请稍后重试`, 502);
      baseSha = data.pull.baseSha;
      headSha = data.pull.headSha;
    }
    const config = await loadConfig();
    const model = request.model?.trim() || config.agent;
    if (!model) throw httpError("未配置默认 LLM 模型（config/llm.json 的 agent 字段）", 503);
    const id = crypto.randomUUID();
    const createdAt = now();
    const writeScope: WriteScope = request.writeScope ?? "off";
    const evalScope: EvalScope = request.evalScope ?? "off";
    const meta: SessionMeta = {
      id,
      title: titleFor(review, request.prNumber, message),
      status: "idle",
      archived: false,
      createdAt,
      updatedAt: createdAt,
      createdBy: request.createdBy,
      source: request.source,
      model,
      writeScope,
      evalScope,
      review,
      ...(request.prNumber !== undefined ? { prNumber: request.prNumber } : {}),
      ...(baseSha ? { baseSha } : {}),
      ...(headSha ? { headSha } : {}),
    };
    await store.put({ meta });
    await launch(id, firstPrompt(review, request.prNumber, message));
    const detail = await agent.get(id);
    if (!detail) throw new Error("会话创建失败");
    return detail;
  },

  async send(id: string, text: string): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    if (record.meta.archived) throw httpError("会话已归档", 400);
    if (record.meta.status === "running" || active.has(id)) {
      throw Object.assign(new Error("会话正在运行中，无法发送新消息"), { status: 409, code: "SESSION_RUNNING" });
    }
    const message = text.trim();
    if (!message) throw httpError("消息不能为空", 400);
    await launch(id, message);
  },

  async abort(id: string): Promise<void> {
    const runtime = runtimes.get(id);
    if (runtime) {
      abortRequested.add(id);
      void runtime.abort();
      return;
    }
    if (active.has(id)) pendingAborts.add(id);
  },

  async archive(id: string): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    if (record.meta.status === "running") void runtimes.get(id)?.abort();
    record.meta.archived = true;
    record.meta.updatedAt = now();
    await store.put(record);
  },

  subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
    const record = store.peek(id);
    if (record) {
      void detailOf(record)
        .then((session) => listener({ type: "snapshot", session }))
        .catch(() => {});
    }
    return hub.subscribe(id, listener);
  },

  async saveDraft(
    id: string,
    draft: Omit<ReviewDraft, "updatedAt" | "publishedAt" | "publishedUrl">,
  ): Promise<ReviewDraft> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const errors = validateDraft(draft, await draftContext(draft.prNumber));
    if (errors.length > 0) throw httpError(errors.join("；"), 400);
    const next: ReviewDraft = { ...draft, updatedAt: now() };
    await writeLocal(id, DRAFT_FILE, serializeDraftFile(next));
    record.meta.updatedAt = next.updatedAt;
    await store.put(record);
    hub.emit(id, { type: "draft", draft: next });
    return next;
  },

  async publish(id: string, by: string): Promise<{ url: string }> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const draft = parseDraftFile(readLocalSync(id, DRAFT_FILE)?.content);
    if (draft === null) throw httpError("没有可发布的审查草稿", 400);
    if (record.meta.prNumber !== undefined && record.meta.prNumber !== draft.prNumber) {
      throw httpError("草稿的 PR 与当前会话绑定的 PR 不一致", 409);
    }
    const { url } = await publishDraft(draft);
    const publishedAt = now();
    const published: ReviewDraft = { ...draft, publishedAt, publishedUrl: url };
    await writeLocal(id, DRAFT_FILE, serializeDraftFile(published));
    record.meta.updatedAt = publishedAt;
    await store.put(record);
    hub.emit(id, { type: "draft", draft: published });
    log.info("审查已发布", { sessionId: id, prNumber: draft.prNumber, by, url });
    return { url };
  },

  async setWriteScope(id: string, writeScope: WriteScope): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    record.meta.writeScope = writeScope;
    record.meta.updatedAt = now();
    await store.put(record);
  },

  async setEvalScope(id: string, evalScope: EvalScope): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    record.meta.evalScope = evalScope;
    record.meta.updatedAt = now();
    await store.put(record);
  },

  async shutdown(): Promise<void> {
    for (const runtime of runtimes.values()) void runtime.abort();
    await Promise.allSettled([...runs.values()]);
    runtimes.clear();
  },
};
