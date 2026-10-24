import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  createAgentSession,
  loadSkillsFromDir,
  type AgentSession,
  type AuthStorage,
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
} from "@cfpa/contracts/api";
import { prdata } from "../prdata.ts";
import { botWritesEnabled } from "../github/client.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { type ToolContext } from "./context.ts";
import { DRAFT_FILE, draftInputSchema, parseDraftFile, serializeDraftFile, validateDraft, type DraftContext } from "./draft.ts";
import { SessionHub } from "./events.ts";
import { applySearchEnv, loadConfig, llm, resolveModel } from "./llm.ts";
import { effortOf, parseRoleSelector } from "./llm-providers.ts";
import { isLocalPath, listLocal, localDir, readLocal, writeLocal } from "./local-store.ts";
import { openAuthStorage, openModelRuntime, openSessionManager, sessionMessages } from "./pi.ts";
import { LiveProjector, projectMessages } from "./projection.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { secretGuard } from "./secret-guard.ts";
import { scopeGuard } from "./scope-guard.ts";
import { sessionTitle } from "./title.ts";
import { SessionStore, summarize, type SessionMeta, type SessionRecord } from "./sessions.ts";
import { registerSchemes } from "./schemes.ts";
import { buildTools } from "./tools/index.ts";
import { publishDraft } from "./workflows/review/publish.ts";
import { generalWorkflow } from "./workflows/general.ts";
import { resolveWorkflow } from "./workflows/index.ts";
import type { WorkflowDefinition } from "./workflows/types.ts";

export { llm };

const log = logger("agent");
const store = new SessionStore();
const hub = new SessionHub();

interface Runtime {
  session: AgentSession;
  unsubscribe: () => void;
  authStorage: AuthStorage;
}

/** 一个会话的全部运行时状态。`turn` 是在跑的唯一真相，`abort` 只对当前 turn 有效。 */
interface Live {
  runtime?: Runtime;
  turn?: Promise<void>;
  /** omp 已受理当前 turn 的 prompt，之后 `isStreaming` 才为真。 */
  admitted?: Promise<void>;
  abort?: boolean;
  /** 当前 turn 结束后丢弃 runtime（配置变更或归档）。 */
  stale?: boolean;
}

const live = new Map<string, Live>();

function slotOf(id: string): Live {
  const existing = live.get(id);
  if (existing) return existing;
  const slot: Live = {};
  live.set(id, slot);
  return slot;
}

const SKILLS_DIR = join(paths.root, "skills");

const ALLOWED_TOOLS: Record<string, true> = {
  read: true,
  write: true,
  edit: true,
  grep: true,
  find: true,
  glob: true,
  todo: true,
  delegate: true,
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
  const cached = live.get(meta.id)?.runtime?.session.agent.state.messages;
  const messages = cached ? [...cached] : await sessionMessages(record);
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
  const slot = live.get(id);
  if (!slot) return;
  const runtime = slot.runtime;
  slot.stale = undefined;
  if (!runtime) return;
  slot.runtime = undefined;
  runtime.unsubscribe();
  try {
    await runtime.session.dispose();
  } finally {
    runtime.authStorage.close();
  }
}

async function getRuntime(record: SessionRecord, slot: Live): Promise<Runtime> {
  const id = record.meta.id;
  if (slot.runtime) return slot.runtime;
  const workflow = resolveWorkflow(record.meta.workflow);
  const config = await loadConfig();
  applySearchEnv(config.search);
  const basePrompt = await buildSystemPrompt(workflow);
  const aliases = Object.keys(config.roles).filter((role) => role !== "default");
  const systemPrompt =
    aliases.length === 0
      ? basePrompt
      : `${basePrompt}\n\n可用模型别名：${aliases.map((role) => `@${role}`).join("、")}。派子代理时用 delegate({ model: "@别名", task: "…" })；单次调用可用 eval 的 await completion(prompt, model="@别名")。`;
  const skills = await agentSkills(workflow);
  const configured = record.meta.thinking;
  const { model, thinking } = await resolveModel(record.meta.model, configured);
  const authStorage = await openAuthStorage(config.endpoints);
  const modelRuntime = await openModelRuntime(authStorage, config.endpoints, config.roles);
  const thinkingLevel: Effort | undefined = thinking === "off" ? undefined : effortOf(thinking);
  const extensions = [
    secretGuard,
    scopeGuard(
      async () => (await store.get(id))?.meta.evalScope === "run",
      async () => (await store.get(id))?.meta.writeScope ?? "off",
    ),
  ];
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
    authStorage,
    modelRegistry: modelRuntime.registry,
    settings: modelRuntime.settings,
    sessionManager: manager,
    customTools: buildTools(toolContext(record), extensions),
    skills,
    extensions,
    disableExtensionDiscovery: true,
    systemPrompt,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }).catch((err) => {
    authStorage.close();
    throw err;
  });
  const session: AgentSession = created.session;
  const entries: SessionEntry[] = manager.getEntries();
  const projector = new LiveProjector(entries.filter((entry) => entry.type === "message").length);
  const unsubscribe = session.subscribe((event) => {
    for (const item of projector.handle(event)) hub.emit(id, { type: "item", item });
  });
  try {
    await session.setActiveToolsByName(
      session.getActiveToolNames().filter((name) => ALLOWED_TOOLS[name] === true || name.startsWith("mcp__")),
    );
  } catch (err) {
    unsubscribe();
    await session.dispose();
    authStorage.close();
    throw err;
  }
  const runtime: Runtime = { session, unsubscribe, authStorage };
  slot.runtime = runtime;
  return runtime;
}

async function runTurn(id: string, prompt: string, admit: () => void, slot: Live): Promise<void> {
  let error: string | undefined;
  try {
    const record = await store.get(id);
    if (!record) return;
    await mkdir(localDir(id), { recursive: true });
    if (process.platform !== "win32") {
      await chmod(dirname(localDir(id)), 0o711);
      await chmod(localDir(id), 0o777);
    }
    const runtime = await getRuntime(record, slot);
    // abort 可能在 runtime 建立期间落下；此时 omp 还没有在途 turn，只能在这里截断。
    if (slot.abort) {
      await runtime.session.abort();
      return;
    }
    await runtime.session.prompt(prompt, { onPromptAdmitted: admit });
    if (slot.abort) return;
    const last = runtime.session.agent.state.messages.at(-1);
    if (last?.role === "assistant" && last.errorMessage) error = last.errorMessage;
  } catch (err) {
    if (slot.abort) return;
    error = err instanceof Error ? err.message : String(err);
    log.error("会话运行失败", { id, err });
    await disposeRuntime(id).catch(() => {});
  } finally {
    slot.abort = undefined;
    admit();
    slot.admitted = undefined;
    const fresh = await store.get(id).catch(() => null);
    if (fresh) {
      fresh.meta.status = "idle";
      fresh.meta.updatedAt = now();
      if (error) fresh.meta.lastError = error;
      else delete fresh.meta.lastError;
      await store.put(fresh).catch((err: unknown) => log.error("会话状态写入失败", { id, err }));
    }
    if (slot.stale || !fresh || fresh.meta.archived) {
      await disposeRuntime(id).catch((err: unknown) => log.error("会话资源释放失败", { id, err }));
    }
    hub.emit(id, { type: "status", status: "idle", ...(error ? { lastError: error } : {}) });
  }
}

/** 同步起一个 turn：`slot.turn` 在第一个 await 之前就位，调用方因此不需要另加在跑标记。 */
function launch(id: string, prompt: string): boolean {
  const slot = live.get(id);
  const record = store.peek(id);
  if (slot?.turn || !record) return false;
  const target = slot ?? slotOf(id);
  target.abort = undefined;
  let admit!: () => void;
  target.admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  record.meta.status = "running";
  record.meta.updatedAt = now();
  delete record.meta.lastError;
  void store.put(record).catch((err: unknown) => log.error("会话状态写入失败", { id, err }));
  hub.emit(id, { type: "status", status: "running" });
  const turn = runTurn(id, prompt, admit, target).catch((err: unknown) => {
    log.error("会话运行失败", { id, err });
  });
  target.turn = turn;
  void turn.finally(() => {
    if (target.turn === turn) target.turn = undefined;
  });
  return true;
}

async function publishOnce(id: string, by: string): Promise<{ url: string }> {
  const record = await store.get(id);
  if (!record) throw httpError("会话不存在", 404);
  const raw = await readLocal(id, DRAFT_FILE);
  const draft = raw === null ? null : parseDraftFile(raw.content);
  if (draft === null) throw httpError("没有可发布的草稿", 400);
  if (!botWritesEnabled()) throw httpError("当前 GitHub 身份不是机器人，已暂停发布审查。", 403);
  const { url } = await publishDraft(draft);
  const value = { ...draft, publishedAt: now(), publishedUrl: url };
  await writeLocal(id, DRAFT_FILE, serializeDraftFile(value));
  record.meta.updatedAt = now();
  await store.put(record);
  hub.emit(id, { type: "artifact", artifact: value });
  log.info("草稿已发布", { sessionId: id, by, url });
  return { url };
}

const publishing = new Map<string, Promise<{ url: string }>>();

export const agent = {
  async init(): Promise<void> {
    await store.init();
    registerSchemes({
      sessionOf: (sessionFile) => {
        if (sessionFile === undefined) return undefined;
        const record = store.all().find((entry) => entry.sessionFile === sessionFile);
        return record === undefined ? undefined : { sessionId: record.meta.id, writeScope: record.meta.writeScope };
      },
    });
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
    const model = request.model?.trim() || parseRoleSelector(config.roles.default ?? "").endpoint;
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
      launch(id, message);
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
    const message = text.trim();
    if (!message) throw httpError("消息不能为空", 400);
    for (;;) {
      const current = await store.get(id);
      if (!current) throw httpError("会话不存在", 404);
      if (current.meta.archived) throw httpError("会话已归档", 400);
      const slot = live.get(id);
      if (!slot?.turn) {
        if (launch(id, message)) return;
        continue;
      }
      // 先等 omp 受理：受理之后 isStreaming 才反映这一轮，steer 才插得进去。
      if (slot.admitted) await slot.admitted;
      const runtime = slot.runtime;
      if (runtime?.session.isStreaming) {
        await runtime.session.prompt(message, { streamingBehavior: "steer" });
        return;
      }
      // runtime 还在建立，或这一轮刚好收尾：等它结束再重新判断。
      await slot.turn;
    }
  },

  async abort(id: string): Promise<void> {
    const slot = live.get(id);
    if (!slot?.turn) return;
    slot.abort = true;
    void slot.runtime?.session.abort().catch(() => {});
  },

  async archive(id: string): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const slot = live.get(id);
    if (slot?.turn) {
      slot.abort = true;
      slot.stale = true;
      void slot.runtime?.session.abort().catch(() => {});
    }
    record.meta.archived = true;
    record.meta.updatedAt = now();
    await store.put(record);
    if (!slot?.turn) await disposeRuntime(id);
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
    const inflight = publishing.get(id);
    if (inflight) return inflight;
    const run = publishOnce(id, by);
    publishing.set(id, run);
    void run.finally(() => {
      if (publishing.get(id) === run) publishing.delete(id);
    });
    return run;
  },

  async setWriteScope(id: string, writeScope: WriteScope): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    record.meta.writeScope = writeScope;
    record.meta.updatedAt = now();
    await store.put(record);
    const slot = live.get(id);
    if (slot?.turn) slot.stale = true;
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
      const slot = live.get(id);
      if (slot?.turn) slot.stale = true;
      else await disposeRuntime(id);
    }
  },

  async shutdown(): Promise<void> {
    const slots = [...live.values()];
    for (const slot of slots) void slot.runtime?.session.abort().catch(() => {});
    await Promise.allSettled(slots.flatMap((slot) => (slot.turn ? [slot.turn] : [])));
    await Promise.allSettled([...live.keys()].map((id) => disposeRuntime(id)));
  },
};
