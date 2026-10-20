import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  loadSkillsFromDir,
  type AgentSession,
  type SessionEntry,
  type Skill,
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
import { isLocalPath, listLocal, localDir, readLocal, writeLocal } from "./local-store.ts";
import { openSessionManager, sessionMessages } from "./pi.ts";
import { mqmTable } from "./mqm.ts";
import { LiveProjector, projectMessages } from "./projection.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { publishDraft } from "./publish.ts";
import { secretGuard } from "./secret-guard.ts";
import { SessionStore, summarize, type SessionMeta, type SessionRecord } from "./sessions.ts";
import { buildTools } from "./tools/index.ts";

export { llm, setModelForTest };

const log = logger("agent");
const store = new SessionStore();
const hub = new SessionHub();

interface Runtime {
  session: AgentSession;
  unsubscribe: () => void;
}

const runtimes = new Map<string, Runtime>();
const staleRuntimes = new Set<string>();
const admissions = new Map<string, Promise<void>>();
const runs = new Map<string, Promise<void>>();
const active = new Set<string>();
const pendingAborts = new Set<string>();
const abortRequested = new Set<string>();

const SKILLS_DIR = join(paths.root, "skills");

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
    return [`审查 PR #${prNumber}`, "先读 skill://review。", message].filter(Boolean).join("\n\n");
  }
  return message || "请查看当前 PR，完成用户要求的操作（默认：理解并汇报 PR 内容）。";
}

async function agentSkills(review: boolean): Promise<Skill[]> {
  if (!review) return [];
  const { skills, warnings } = await loadSkillsFromDir({ dir: SKILLS_DIR, source: "cfpa" });
  for (const warning of warnings) log.warn("技能加载告警", { warning });
  return skills;
}

async function listDrafts(id: string): Promise<{ file: string; draft: ReviewDraft }[]> {
  const files = await listLocal(id);
  const json = files
    .filter((file) => file.name.endsWith(".json"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const drafts: { file: string; draft: ReviewDraft }[] = [];
  for (const file of json) {
    const draft = parseDraftFile((await readLocal(id, file.name))?.content);
    if (draft !== null) drafts.push({ file: file.name, draft });
  }
  return drafts;
}

async function detailOf(record: SessionRecord): Promise<SessionDetail> {
  const meta = record.meta;
  const drafts = await listDrafts(meta.id);
  const preferred = drafts.find((entry) => entry.file === DRAFT_FILE);
  const live = runtimes.get(meta.id)?.session.agent.state.messages;
  const messages = live ? [...live] : await sessionMessages(record);
  return {
    ...summarize(record),
    items: projectMessages(messages),
    ...(preferred ? { draft: preferred.draft, draftFile: preferred.file } : {}),
    ...(!preferred && drafts.length > 0 ? { draftFiles: drafts.map((entry) => entry.file) } : {}),
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

async function disposeRuntime(id: string): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) return;
  runtimes.delete(id);
  runtime.unsubscribe();
  await runtime.session.dispose();
}

async function getRuntime(record: SessionRecord): Promise<Runtime> {
  const id = record.meta.id;
  if (staleRuntimes.delete(id)) await disposeRuntime(id);
  const existing = runtimes.get(id);
  if (existing) return existing;
  const systemPrompt = await buildSystemPrompt(record.meta.review);
  const skills = await agentSkills(record.meta.review);
  const { model, apiKey, endpoint } = await resolveModel(record.meta.model);
  const manager = await openSessionManager(record);
  const sessionFile = manager.getSessionFile() ?? record.sessionFile;
  if (sessionFile) {
    record.sessionFile = sessionFile;
    await store.put(record);
  }
  const created = await createAgentSession({
    cwd: paths.root,
    agentDir: paths.piAgent,
    model,
    getApiKey: async () => apiKey,
    sessionManager: manager,
    customTools: buildTools(toolContext(record)),
    skills,
    extensions: [secretGuard],
    disableExtensionDiscovery: true,
    systemPrompt,
    ...(endpoint ? { thinkingLevel: reasoningOf(endpoint) } : {}),
  });
  const session: AgentSession = created.session;
  const entries: SessionEntry[] = manager.getEntries();
  const projector = new LiveProjector(entries.filter((entry) => entry.type === "message").length);
  const unsubscribe = session.subscribe((event) => {
    for (const item of projector.handle(event)) hub.emit(id, { type: "item", item });
  });
  const exec = record.meta.evalScope === "run";
  try {
    await session.setActiveToolsByName(
      session.getActiveToolNames().filter(
        (name) => ALLOWED_TOOLS[name] === true || ((name === "eval" || name === "bash") && exec),
      ),
    );
  } catch (err) {
    unsubscribe();
    await session.dispose();
    throw err;
  }
  const runtime: Runtime = { session, unsubscribe };
  runtimes.set(id, runtime);
  return runtime;
}

async function runTurn(id: string, prompt: string, admit: () => void): Promise<void> {
  let error: string | undefined;
  let aborted = pendingAborts.delete(id);
  try {
    const record = await store.get(id);
    if (!record) return;
    await mkdir(localDir(id), { recursive: true });
    if (process.platform !== "win32") {
      await chmod(dirname(localDir(id)), 0o711);
      await chmod(localDir(id), 0o777);
    }
    const runtime = await getRuntime(record);
    const abortNow = aborted || pendingAborts.delete(id) || abortRequested.delete(id);
    if (abortNow) {
      aborted = true;
      pendingAborts.delete(id);
      abortRequested.delete(id);
      await runtime.session.abort();
      return;
    }
    await runtime.session.prompt(prompt, { onPromptAdmitted: admit });
    if (abortRequested.delete(id)) aborted = true;
    if (!aborted) {
      const last = runtime.session.agent.state.messages.at(-1);
      if (last?.role === "assistant" && last.errorMessage) error = last.errorMessage;
    }
  } catch (err) {
    if (aborted || abortRequested.delete(id)) {
      aborted = true;
      abortRequested.delete(id);
    } else {
      error = err instanceof Error ? err.message : String(err);
      log.error("会话运行失败", { id, err });
      await disposeRuntime(id).catch(() => {});
    }
  } finally {
    admit();
    admissions.delete(id);
    active.delete(id);
    const fresh = await store.get(id).catch(() => null);
    if (fresh) {
      fresh.meta.status = "idle";
      fresh.meta.updatedAt = now();
      if (error) fresh.meta.lastError = error;
      else delete fresh.meta.lastError;
      await store.put(fresh).catch((err: unknown) => log.error("会话状态写入失败", { id, err }));
      const stale = staleRuntimes.delete(id);
      if (fresh.meta.archived || stale) {
        await disposeRuntime(id).catch((err: unknown) => log.error("会话资源释放失败", { id, err }));
      }
    } else {
      staleRuntimes.delete(id);
      await disposeRuntime(id).catch((err: unknown) => log.error("会话资源释放失败", { id, err }));
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
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  admissions.set(id, admitted);
  const run = runTurn(id, prompt, admit).catch((err: unknown) => {
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
    const evalScope: EvalScope = request.evalScope ?? (review ? "run" : "off");
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
    const message = text.trim();
    if (!message) throw httpError("消息不能为空", 400);
    for (;;) {
      const current = await store.get(id);
      if (!current) throw httpError("会话不存在", 404);
      if (current.meta.archived) throw httpError("会话已归档", 400);
      if (current.meta.status !== "running" && !active.has(id)) {
        await launch(id, message);
        return;
      }
      const admitted = admissions.get(id);
      if (admitted) await admitted;
      const runtime = runtimes.get(id);
      if (runtime?.session.isStreaming) {
        await runtime.session.prompt(message, { streamingBehavior: "steer" });
        return;
      }
      const run = runs.get(id);
      if (!run) throw Object.assign(new Error("会话正在切换状态，请稍后再发"), { status: 409, code: "SESSION_BUSY" });
      await run;
    }
  },

  async abort(id: string): Promise<void> {
    const runtime = runtimes.get(id);
    if (runtime) {
      if (active.has(id)) {
        abortRequested.add(id);
        void runtime.session.abort().catch(() => {});
      }
      return;
    }
    if (active.has(id)) pendingAborts.add(id);
  },

  async archive(id: string): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const running = record.meta.status === "running";
    if (running) {
      abortRequested.add(id);
      staleRuntimes.add(id);
      void runtimes.get(id)?.session.abort().catch(() => {});
    }
    record.meta.archived = true;
    record.meta.updatedAt = now();
    await store.put(record);
    if (!running) await disposeRuntime(id);
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

  async readDraft(id: string, file: string): Promise<ReviewDraft> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const draft = parseDraftFile((await readLocal(id, file))?.content);
    if (draft === null) throw httpError("草稿文件不存在或不是合法 draft", 404);
    return draft;
  },

  async saveDraft(
    id: string,
    draft: Omit<ReviewDraft, "updatedAt" | "publishedAt" | "publishedUrl">,
    draftFile?: string,
  ): Promise<ReviewDraft> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const errors = validateDraft(draft, await draftContext(draft.prNumber));
    if (errors.length > 0) throw httpError(errors.join("；"), 400);
    const next: ReviewDraft = { ...draft, updatedAt: now() };
    await writeLocal(id, draftFile ?? DRAFT_FILE, serializeDraftFile(next));
    record.meta.updatedAt = next.updatedAt;
    await store.put(record);
    hub.emit(id, { type: "draft", draft: next });
    return next;
  },

  async publish(id: string, by: string, draftFile?: string): Promise<{ url: string }> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const found = draftFile
      ? { file: draftFile, draft: parseDraftFile((await readLocal(id, draftFile))?.content) }
      : ((await listDrafts(id)).find((entry) => entry.file === DRAFT_FILE) ?? null);
    if (found === null || found.draft === null) throw httpError("没有可发布的审查草稿", 400);
    const draft = found.draft;
    if (record.meta.prNumber !== undefined && record.meta.prNumber !== draft.prNumber) {
      throw httpError("草稿的 PR 与当前会话绑定的 PR 不一致", 409);
    }
    const { url } = await publishDraft(draft);
    const publishedAt = now();
    const published: ReviewDraft = { ...draft, publishedAt, publishedUrl: url };
    await writeLocal(id, found.file, serializeDraftFile(published));
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
    if (active.has(id)) staleRuntimes.add(id);
    else await disposeRuntime(id);
  },

  async setEvalScope(id: string, evalScope: EvalScope): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    record.meta.evalScope = evalScope;
    record.meta.updatedAt = now();
    await store.put(record);
    if (active.has(id)) staleRuntimes.add(id);
    else await disposeRuntime(id);
  },

  async shutdown(): Promise<void> {
    for (const runtime of runtimes.values()) void runtime.session.abort().catch(() => {});
    await Promise.allSettled([...runs.values()]);
    await Promise.allSettled([...runtimes.keys()].map((id) => disposeRuntime(id)));
  },
};
