import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  createAgentSession,
  loadSkillsFromDir,
  type AgentSession,
  type SessionEntry,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
  CreateSessionRequest,
  EvalScope,
  SessionDetail,
  SessionEvent,
  SessionSummary,
  ThinkingLevel,
  WriteScope,
} from "../../shared/api.ts";
import { prdata } from "../prdata.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { type ToolContext } from "./context.ts";
import { DRAFT_FILE, draftInputSchema, parseDraftFile, serializeDraftFile, validateDraft, type DraftContext } from "./draft.ts";
import { SessionHub } from "./events.ts";
import { applySearchEnv, loadConfig, llm, resolveModel, setModelForTest } from "./llm.ts";
import { effortOf } from "./llm-providers.ts";
import { isLocalPath, listLocal, localDir, readLocal, writeLocal } from "./local-store.ts";
import { openSessionManager, sessionMessages } from "./pi.ts";
import { LiveProjector, projectMessages } from "./projection.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { secretGuard } from "./secret-guard.ts";
import { scopeGuard } from "./scope-guard.ts";
import { sessionTitle } from "./title.ts";
import { SessionStore, summarize, type SessionMeta, type SessionRecord } from "./sessions.ts";
import { buildTools } from "./tools/index.ts";
import { publishDraft } from "./workflows/review/publish.ts";
import { generalWorkflow } from "./workflows/general.ts";
import { resolveWorkflow } from "./workflows/index.ts";
import type { WorkflowDefinition } from "./workflows/types.ts";

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
  bash: true,
  eval: true,
};

function httpError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), { status, ...(code === undefined ? {} : { code }) });
}

function now(): string {
  return new Date().toISOString();
}

async function agentSkills(workflow: WorkflowDefinition): Promise<Skill[]> {
  if (workflow.skills.length === 0) return [];
  const { skills, warnings } = await loadSkillsFromDir({ dir: SKILLS_DIR, source: "cfpa" });
  for (const warning of warnings) log.warn("技能加载告警", { warning });
  const wanted = new Set(workflow.skills);
  const selected = skills.filter((skill) => wanted.has(skill.name));
  for (const name of workflow.skills) {
    if (!selected.some((skill) => skill.name === name)) {
      log.warn("工作流技能未找到", { workflow: workflow.id, name });
    }
  }
  return selected;
}

async function detailOf(record: SessionRecord): Promise<SessionDetail> {
  const meta = record.meta;
  const raw = await readLocal(meta.id, DRAFT_FILE);
  const draft = raw === null ? null : parseDraftFile(raw.content);
  const live = runtimes.get(meta.id)?.session.agent.state.messages;
  const messages = live ? [...live] : await sessionMessages(record);
  return {
    ...summarize(
      record,
      draft !== null,
      draft ? { prNumber: draft.prNumber, verdict: draft.verdict, comments: draft.comments.length } : undefined,
    ),
    items: projectMessages(messages),
    ...(draft !== null ? { artifact: draft, artifactFile: DRAFT_FILE } : {}),
  };
}

const draftInput = draftInputSchema.omit({ event: true }).extend({ headSha: z.string().min(1) });

async function draftContext(prNumber: number): Promise<DraftContext> {
  const data = await prdata.files(prNumber).catch(() => null);
  const patches = new Map<string, string | undefined>((data?.files ?? []).map((file) => [file.path, file.patch]));
  return { patches };
}

function toolContext(record: SessionRecord): ToolContext {
  const id = record.meta.id;
  return {
    sessionId: id,
    writeScope: record.meta.writeScope,
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
  const workflow = resolveWorkflow(record.meta.workflow);
  applySearchEnv((await loadConfig()).search);
  const systemPrompt = await buildSystemPrompt(workflow);
  const skills = await agentSkills(workflow);
  const configured = record.meta.thinking;
  const { model, apiKey, thinking } = await resolveModel(record.meta.model, configured);
  const thinkingLevel: Effort | undefined = thinking === "off" ? undefined : effortOf(thinking);
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
    extensions: [secretGuard, scopeGuard(async () => (await store.get(id))?.meta.evalScope === "run")],
    disableExtensionDiscovery: true,
    systemPrompt,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  });
  const session: AgentSession = created.session;
  const entries: SessionEntry[] = manager.getEntries();
  const projector = new LiveProjector(entries.filter((entry) => entry.type === "message").length);
  const unsubscribe = session.subscribe((event) => {
    for (const item of projector.handle(event)) hub.emit(id, { type: "item", item });
  });
  try {
    await session.setActiveToolsByName(
      session.getActiveToolNames().filter((name) => ALLOWED_TOOLS[name] === true),
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
    const summaries = await Promise.all(
      store.all().map(async (record) => {
        const raw = await readLocal(record.meta.id, DRAFT_FILE);
        const draft = raw === null ? null : parseDraftFile(raw.content);
        return summarize(
          record,
          raw !== null,
          draft ? { prNumber: draft.prNumber, verdict: draft.verdict, comments: draft.comments.length } : undefined,
        );
      }),
    );
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async get(id: string): Promise<SessionDetail | null> {
    const record = await store.get(id);
    return record ? await detailOf(record) : null;
  },

  async create(request: CreateSessionRequest & { createdBy: string; source: "web" | "github" }): Promise<SessionDetail> {
    const message = request.message?.trim();
    if (!message) throw httpError("需要提供 message", 400);
    const config = await loadConfig();
    const model = request.model?.trim() || config.agent || "";
    const modelError = await resolveModel(model === "" ? undefined : model).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    const workflow = generalWorkflow;
    const id = crypto.randomUUID();
    const createdAt = now();
    const prefix = request.prNumber === undefined ? "" : `PR #${request.prNumber} · `;
    const meta: SessionMeta = {
      id,
      title: `${prefix}${await sessionTitle(message, model)}`,
      status: "idle",
      archived: false,
      createdAt,
      updatedAt: createdAt,
      createdBy: request.createdBy,
      source: request.source,
      model,
      writeScope: request.writeScope ?? workflow.defaults.writeScope,
      evalScope: request.evalScope ?? workflow.defaults.evalScope,
      workflow: workflow.id,
      ...(request.prNumber === undefined ? {} : { prNumber: request.prNumber }),
    };
    const record: SessionRecord = { meta };
    await store.put(record);
    if (modelError === undefined) {
      await launch(id, message);
    } else {
      meta.lastError = modelError;
      try {
        const manager = await openSessionManager(record);
        manager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
        await manager.ensureOnDisk();
      } catch (err) {
        log.warn("首条消息写入失败", { id, err });
      }
      await store.put(record);
    }
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

  async readArtifact(id: string): Promise<unknown> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const raw = await readLocal(id, DRAFT_FILE);
    const draft = raw === null ? null : parseDraftFile(raw.content);
    if (draft === null) throw httpError("草稿不存在或格式不合法", 404);
    return draft;
  },

  async saveArtifact(id: string, input: unknown): Promise<unknown> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const parsed = draftInput.safeParse(input);
    if (!parsed.success) throw httpError(parsed.error.issues.map((issue) => issue.message).join("；"), 400);
    const errors = await validateDraft(parsed.data, await draftContext(parsed.data.prNumber));
    if (errors.length > 0) throw httpError(errors.join("；"), 400);
    const value = { ...parsed.data, updatedAt: now() };
    await writeLocal(id, DRAFT_FILE, serializeDraftFile(value));
    record.meta.updatedAt = now();
    await store.put(record);
    hub.emit(id, { type: "artifact", artifact: value });
    return value;
  },

  async publishArtifact(id: string, by: string): Promise<{ url: string }> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const raw = await readLocal(id, DRAFT_FILE);
    const draft = raw === null ? null : parseDraftFile(raw.content);
    if (draft === null) throw httpError("没有可发布的草稿", 400);
    const { url } = await publishDraft(draft);
    const value = { ...draft, publishedAt: now(), publishedUrl: url };
    await writeLocal(id, DRAFT_FILE, serializeDraftFile(value));
    record.meta.updatedAt = now();
    await store.put(record);
    hub.emit(id, { type: "artifact", artifact: value });
    log.info("草稿已发布", { sessionId: id, by, url });
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
  },

  async setConfig(
    id: string,
    patch: { model?: string; thinking?: ThinkingLevel | null; prNumber?: number | null },
  ): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const meta = record.meta;
    let runtimeChanged = false;

    if (patch.model !== undefined) {
      meta.model = patch.model.trim();
      runtimeChanged = true;
    }
    if (patch.thinking !== undefined) {
      if (patch.thinking === null) delete meta.thinking;
      else meta.thinking = patch.thinking;
      runtimeChanged = true;
    }
    if (patch.prNumber !== undefined) {
      const base = meta.title.replace(/^PR #\d+ · /u, "");
      if (patch.prNumber === null) {
        delete meta.prNumber;
        meta.title = base;
      } else {
        meta.prNumber = patch.prNumber;
        meta.title = `PR #${patch.prNumber} · ${base}`;
      }
    }

    if (runtimeChanged) {
      const modelError = await resolveModel(meta.model || undefined).then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      if (modelError === undefined) delete meta.lastError;
      else meta.lastError = modelError;
    }

    meta.updatedAt = now();
    await store.put(record);
    if (runtimeChanged) {
      if (active.has(id)) staleRuntimes.add(id);
      else await disposeRuntime(id);
    }
  },

  async shutdown(): Promise<void> {
    for (const runtime of runtimes.values()) void runtime.session.abort().catch(() => {});
    await Promise.allSettled([...runs.values()]);
    await Promise.allSettled([...runtimes.keys()].map((id) => disposeRuntime(id)));
  },
};
