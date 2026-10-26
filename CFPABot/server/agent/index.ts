import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  createAgentSession,
  loadSkillsFromDir,
  type AgentSession,
  type AuthStorage,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { committedTodoPhases } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import type {
  CreateSessionRequest,
  EvalScope,
  SessionDetail,
  SessionEvent,
  SessionFile,
  SessionFileContent,
  SessionStatus,
  SessionSummary,
  SubagentTranscript,
  ThinkingLevel,
  WriteScope,
} from "@cfpa/contracts/api";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { type ToolContext } from "./context.ts";
import { agentMcpManager, closeAgentMcp } from "./mcp.ts";
import { DRAFT_FILE, draftInputSchema, parseDraftFile } from "./draft.ts";
import { markPublishedOf, saveDraftOf } from "../harness/review/draft.ts";
import { SessionHub, statusEventOf } from "./events.ts";
import { applySearchEnv, loadConfig, llm, resolveModel } from "./llm.ts";
import { effortOf, parseRoleSelector } from "./llm-providers.ts";
import { isLocalPath, listLocal, localDir, readLocal } from "./local-store.ts";
import { openAuthStorage, openModelRuntime, openSessionManager, messagesFromFile, planFromFile } from "./pi.ts";
import { LiveProjector, projectMessages } from "./projection.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { sandbox } from "./plugins/sandbox.ts";
import { fallbackTitle, sessionTitle } from "./title.ts";
import { SessionStore, summarize, type SessionMeta, type SessionRecord } from "./sessions.ts";
import { registerSchemes } from "./schemes.ts";
import { subagentTranscript, loadSubagents } from "./subagents.ts";
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
  projector: LiveProjector;
  unsubscribe: () => void;
  mcpUnsubscribe?: () => void;
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

/** 回合力以 session 事件为准：omp 自己起的续跑回合也能被看见、被中止、被归档。 */
function markStatus(id: string, status: SessionStatus): void {
  const record = store.peek(id);
  if (!record) return;
  const changed = record.meta.status !== status;
  record.meta.status = status;
  record.meta.updatedAt = now();
  void store.put(record).catch((err: unknown) => log.error("会话状态写入失败", { id, err }));
  const slot = live.get(id);
  if (changed) hub.emit(id, { type: "status", status });
  if (status === "idle" && !slot?.turn && (slot?.stale || record.meta.archived)) {
    void disposeRuntime(id).catch((err: unknown) => log.error("会话资源释放失败", { id, err }));
  }
}

let skillsPromise: Promise<Skill[]> | undefined;

function allSkills(): Promise<Skill[]> {
  skillsPromise ??= loadSkillsFromDir({ dir: SKILLS_DIR, source: "cfpa" }).then(({ skills, warnings }) => {
    for (const warning of warnings) log.warn("技能加载告警", { warning });
    return skills;
  });
  return skillsPromise;
}

async function agentSkills(workflow: WorkflowDefinition): Promise<Skill[]> {
  if (workflow.skills.length === 0) return [];
  const skills = await allSkills();
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
  const [subagents, plan] = await Promise.all([
    loadSubagents(meta.id),
    live.get(meta.id)?.runtime?.session.getTodoPhases() ?? planFromFile(record.sessionFile),
  ]);
  // 异步都走完再读运行中状态：快照与随后的 SSE 事件之间尽量不留窗口。
  const runtime = live.get(meta.id)?.runtime;
  const cached = runtime?.session.agent.state.messages;
  const messages = cached ? [...cached] : await messagesFromFile(record.sessionFile);
  const items = projectMessages(messages, runtime?.session.agent.state.pendingToolCalls);
  const partial = runtime?.projector.partial();
  if (partial !== undefined) items.push(partial);
  return {
    ...summarize(
      record,
      draft !== null,
      draft ? { prNumber: draft.prNumber, verdict: draft.verdict, comments: draft.comments.length } : undefined,
    ),
    items,
    ...(subagents.length === 0 ? {} : { subagents }),
    ...(plan.length === 0 ? {} : { plan }),
    ...(draft !== null ? { artifact: draft, artifactFile: DRAFT_FILE } : {}),
  };
}

const draftInput = draftInputSchema.omit({ event: true }).extend({ headSha: z.string().min(1) });

function toolContext(
  record: SessionRecord,
  mcp: { current?: MCPManager },
  session: { current?: AgentSession },
): ToolContext {
  const id = record.meta.id;
  return {
    sessionId: id,
    ...(record.meta.prNumber === undefined ? {} : { prNumber: record.meta.prNumber }),
    mcpManager: () => mcp.current,
    session: () => session.current,
    emit: (event) => hub.emit(id, event),
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
  runtime.mcpUnsubscribe?.();
  try {
    await runtime.session.dispose();
  } finally {
    runtime.authStorage.close();
  }
  if (!slot.turn && live.get(id) === slot) live.delete(id);
}

async function getRuntime(record: SessionRecord, slot: Live): Promise<Runtime> {
  const id = record.meta.id;
  if (slot.runtime) return slot.runtime;
  const workflow = resolveWorkflow(record.meta.workflow);
  const config = await loadConfig();
  applySearchEnv(config.search);
  const aliases = Object.keys(config.roles).filter((role) => role !== "default");
  const systemPrompt = await buildSystemPrompt(workflow, localDir(id), paths.root, record.meta.prNumber, aliases);
  const skills = await agentSkills(workflow);
  const configured = record.meta.thinking;
  const { model, thinking } = await resolveModel(record.meta.model, configured);
  const authStorage = await openAuthStorage(config.endpoints);
  const modelRuntime = await openModelRuntime(authStorage, config.endpoints, config.roles);
  const thinkingLevel: Effort | undefined = thinking === "off" ? undefined : effortOf(thinking);
  const extensions = [
    sandbox({
      workspace: localDir(id),
      execAllowed: async () => (await store.get(id))?.meta.evalScope === "run",
    }),
  ];
  const manager = await openSessionManager(record);
  const sessionFile = manager.getSessionFile() ?? record.sessionFile;
  if (sessionFile) {
    record.sessionFile = sessionFile;
    await store.put(record);
  }
  const mcp: { current?: MCPManager } = {};
  const sessionRef: { current?: AgentSession } = {};
  const mcpManager = await agentMcpManager();
  const customTools = buildTools(toolContext(record, mcp, sessionRef), Object.keys(ALLOWED_TOOLS), extensions);
  const created = await createAgentSession({
    // 发现面（.mcp.json、规则）以仓库根为准；运行时 cwd 由 sessionManager 的 workspace 决定。
    cwd: paths.root,
    agentDir: paths.piAgent,
    model,
    authStorage,
    modelRegistry: modelRuntime.registry,
    settings: modelRuntime.settings,
    sessionManager: manager,
    customTools,
    toolNames: [...new Set([...Object.keys(ALLOWED_TOOLS), ...customTools.map((tool) => tool.name)])],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    skills,
    extensions,
    disableExtensionDiscovery: true,
    systemPrompt,
    ...(mcpManager === undefined ? { enableMCP: false } : { mcpManager }),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }).catch((err) => {
    authStorage.close();
    throw err;
  });
  const session: AgentSession = created.session;
  sessionRef.current = session;
  mcp.current = mcpManager;
  // MCP 工具由 manager 拥有，非 UI 路径 omp 不会自动激活，必须显式刷新一次。
  if (mcpManager) await session.refreshMCPTools(mcpManager.getTools());
  const projector = new LiveProjector(session.agent.state.messages.length);
  const unsubscribe = session.subscribe((event) => {
    for (const item of projector.handle(event)) hub.emit(id, { type: "item", item });
    if (event.type === "tool_execution_end" && event.toolName === "todo") {
      const plan = committedTodoPhases(event.result);
      if (plan !== undefined) hub.emit(id, { type: "plan", plan });
    }
    const status = statusEventOf(event);
    if (status !== undefined) hub.emit(id, status);
    if (event.type === "agent_start") markStatus(id, "running");
    else if (event.type === "agent_end" && event.isTerminal !== false) markStatus(id, "idle");
    else if (event.type === "queue_update") {
      hub.emit(id, { type: "queue", steering: event.steering, followUp: event.followUp });
    }
    if (event.type === "message_end" && event.message.role === "assistant") hub.emit(id, { type: "step", phase: "end" });
  });
  try {
    // getActiveToolNames() 不保证包含 SDK customTools；只按它过滤会把 bash/delegate 一起丢掉。
    const active = new Set([...session.getActiveToolNames(), ...customTools.map((tool) => tool.name)]);
    await session.setActiveToolsByName(
      [...active].filter((name) => ALLOWED_TOOLS[name] === true || name.startsWith("mcp__")),
    );
    log.info("会话工具已激活", { sessionId: id, tools: session.getActiveToolNames() });
    if (session.getToolByName("delegate") === undefined) {
      log.error("delegate 未注册：prompt 的派单步骤不可执行，按片自己审", { sessionId: id });
    }
  } catch (err) {
    unsubscribe();
    await session.dispose();
    authStorage.close();
    throw err;
  }
  const runtime: Runtime = { session, projector, unsubscribe, authStorage };
  if (mcp.current !== undefined) {
    const manager = mcp.current;
    runtime.mcpUnsubscribe = manager.addToolsChangedListener(() => {
      void session.refreshMCPTools(manager.getTools()).catch((err: unknown) => {
        log.warn("MCP 工具刷新失败", { sessionId: id, err });
      });
    });
  }
  slot.runtime = runtime;
  return runtime;
}

async function runTurn(id: string, prompt: string, admit: () => void, slot: Live): Promise<void> {
  let error: string | undefined;
  try {
    const record = await store.get(id);
    if (!record || record.meta.archived) return;
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
    const accepted = await runtime.session.prompt(prompt, { onPromptAdmitted: admit });
    if (accepted === false) throw new Error("消息未被模型受理（上下文预算不足或运行已取消）。");
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
    const streaming = slot.runtime?.session.isStreaming === true;
    const fresh = await store.get(id).catch(() => null);
    if (fresh) {
      if (!streaming) fresh.meta.status = "idle";
      fresh.meta.updatedAt = now();
      if (error) fresh.meta.lastError = error;
      else delete fresh.meta.lastError;
      await store.put(fresh).catch((err: unknown) => log.error("会话状态写入失败", { id, err }));
    }
    if (!streaming) hub.emit(id, { type: "status", status: "idle", ...(error ? { lastError: error } : {}) });
    if (!streaming && (slot.stale || !fresh || fresh.meta.archived)) {
      await disposeRuntime(id).catch((err: unknown) => log.error("会话资源释放失败", { id, err }));
    }
  }
}

/** 同步起一个 turn：`slot.turn` 在第一个 await 之前就位，调用方因此不需要另加在跑标记。 */
function launch(id: string, prompt: string): boolean {
  const slot = live.get(id);
  const record = store.peek(id);
  if (slot?.turn || !record || record.meta.archived) return false;
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
    if (target.runtime === undefined && target.turn === undefined && live.get(id) === target) live.delete(id);
  });
  return true;
}

/** 标题只取用户消息，摘要不占创建请求：先落首行，模型回来再改写并广播。 */
async function summarizeTitle(id: string, message: string, model: string, prefix: string, base: string): Promise<void> {
  try {
    const title = await sessionTitle(message, model);
    const record = await store.get(id);
    // 摘要期间标题可能已被改绑 PR 换过，只在还是占位标题时回填。
    if (!record || title === base || record.meta.title !== `${prefix}${base}`) return;
    record.meta.title = `${prefix}${title}`;
    await store.put(record);
    hub.touch(id);
  } catch (err) {
    log.warn("标题摘要失败", { id, err });
  }
}

async function publishOnce(id: string, by: string): Promise<{ url: string }> {
  const record = await store.get(id);
  if (!record) throw httpError("会话不存在", 404);
  const raw = await readLocal(id, DRAFT_FILE);
  const draft = raw === null ? null : parseDraftFile(raw.content);
  if (draft === null) throw httpError("没有可发布的草稿", 400);
  if (record.meta.prNumber !== undefined && record.meta.prNumber !== draft.prNumber) {
    throw httpError(`会话绑定 PR #${record.meta.prNumber}，草稿属于 PR #${draft.prNumber}`, 400);
  }
  const { url } = await publishDraft(draft);
  const value = await markPublishedOf(draft.prNumber, id, draft, url);
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
      sessionOf: (ref) => {
        if (ref === undefined) return undefined;
        const record = store.all().find((entry) => entry.sessionFile === ref || entry.meta.id === ref);
        return record === undefined ? undefined : { sessionId: record.meta.id, writeScope: record.meta.writeScope };
      },
      onDraftSaved: async (id, draft) => {
        const record = await store.get(id);
        if (!record) return;
        record.meta.updatedAt = now();
        await store.put(record);
        hub.touch(id);
        hub.emit(id, { type: "artifact", artifact: draft });
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
    const fixedTitle = request.title?.trim() ?? "";
    const prefix = request.prNumber === undefined ? "" : `#${request.prNumber} · `;
    const baseTitle = fixedTitle === "" ? fallbackTitle(message) : fixedTitle;
    const meta: SessionMeta = {
      id,
      title: `${prefix}${baseTitle}`,
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
    hub.touch(id);
    if (fixedTitle === "") void summarizeTitle(id, message, model, prefix, baseTitle);
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
      hub.emit(id, { type: "status", status: "idle", lastError: modelError });
    }
    const detail = await agent.get(id);
    if (!detail) throw new Error("会话创建失败");
    return detail;
  },

  async send(id: string, text: string): Promise<void> {
    const message = text.trim();
    if (!message) throw httpError("消息不能为空", 400);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await store.get(id);
      if (!current) throw httpError("会话不存在", 404);
      if (current.meta.archived) throw httpError("会话已归档", 400);
      const slot = live.get(id);
      const session = slot?.runtime?.session;
      // 流式中立刻排队：omp 在下一个步边界注入，而不是等一下个 step 事件再发。
      if (session?.isStreaming) {
        await session.prompt(message, { streamingBehavior: "steer" });
        return;
      }
      if (!slot?.turn) {
        if (launch(id, message)) return;
        continue;
      }
      // runtime 还在建立：等 omp 受理，受理之后 isStreaming 才反映这一轮。
      await (slot.admitted ?? slot.turn);
    }
    throw httpError("会话持续忙碌，消息未受理", 409, "session_busy");
  },

  async abort(id: string): Promise<void> {
    const slot = live.get(id);
    const session = slot?.runtime?.session;
    if (!session) return;
    slot.abort = true;
    void session.abort().catch(() => {});
  },

  async subagent(id: string, agentId: string, offset: number): Promise<SubagentTranscript> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404, "not_found");
    return subagentTranscript(id, agentId, offset);
  },

  async archive(id: string): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const slot = live.get(id);
    const busy = slot?.turn !== undefined || slot?.runtime?.session.isStreaming === true;
    if (busy && slot !== undefined) {
      slot.abort = true;
      slot.stale = true;
      void slot.runtime?.session.abort().catch(() => {});
    }
    record.meta.archived = true;
    record.meta.updatedAt = now();
    await store.put(record);
    hub.touch(id);
    if (!busy) await disposeRuntime(id);
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

  subscribeAll(listener: (sessionId: string) => void): () => void {
    return hub.subscribeAll(listener);
  },

  async listFiles(id: string): Promise<SessionFile[]> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    return listLocal(id);
  },

  async readFile(id: string, name: string): Promise<SessionFileContent> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    if (!isLocalPath(name)) throw httpError("文件路径不合法", 400);
    const entry = await readLocal(id, name);
    if (entry === null) throw httpError("文件不存在", 404);
    return { name, content: entry.content, size: Buffer.byteLength(entry.content), updatedAt: entry.updatedAt };
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
    if (record.meta.prNumber !== undefined && record.meta.prNumber !== parsed.data.prNumber) {
      throw httpError(`会话绑定 PR #${record.meta.prNumber}，不能保存 PR #${parsed.data.prNumber} 的草稿`, 400);
    }
    const saved = await saveDraftOf(parsed.data.prNumber, id, JSON.stringify(parsed.data));
    if (!saved.ok || saved.draft === undefined) throw httpError(saved.errors.join("；"), 400);
    record.meta.updatedAt = now();
    await store.put(record);
    hub.emit(id, { type: "artifact", artifact: saved.draft });
    return saved.draft;
  },

  async publishArtifact(id: string, by: string): Promise<{ url: string }> {
    const inflight = publishing.get(id);
    if (inflight) return inflight;
    const run = publishOnce(id, by);
    publishing.set(id, run);
    void run.finally(() => {
      if (publishing.get(id) === run) publishing.delete(id);
    }).catch(() => undefined);
    return run;
  },

  async setWriteScope(id: string, writeScope: WriteScope): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    record.meta.writeScope = writeScope;
    record.meta.updatedAt = now();
    await store.put(record);
    hub.touch(id);
    const slot = live.get(id);
    if (slot?.turn !== undefined || slot?.runtime?.session.isStreaming === true) slot.stale = true;
    else await disposeRuntime(id);
  },

  async setEvalScope(id: string, evalScope: EvalScope): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    record.meta.evalScope = evalScope;
    record.meta.updatedAt = now();
    await store.put(record);
    hub.touch(id);
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
      const base = meta.title.replace(/^(?:PR )?#\d+ · /u, "");
      if (patch.prNumber === null) {
        delete meta.prNumber;
        meta.title = base;
      } else {
        meta.prNumber = patch.prNumber;
        meta.title = `#${patch.prNumber} · ${base}`;
      }
      runtimeChanged = true;
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
    hub.touch(id);
    if (runtimeChanged) {
      const slot = live.get(id);
      if (slot?.turn !== undefined || slot?.runtime?.session.isStreaming === true) slot.stale = true;
      else await disposeRuntime(id);
    }
  },

  async shutdown(): Promise<void> {
    const slots = [...live.values()];
    for (const slot of slots) void slot.runtime?.session.abort().catch(() => {});
    await Promise.allSettled(slots.flatMap((slot) => (slot.turn ? [slot.turn] : [])));
    await Promise.allSettled([...publishing.values()]);
    await Promise.allSettled([...live.keys()].map((id) => disposeRuntime(id)));
    await closeAgentMcp();
  },
};
