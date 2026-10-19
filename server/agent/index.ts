import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { type ToolContext } from "./context.ts";
import { DRAFT_FILE, parseDraftFile, serializeDraftFile, validateDraft, type DraftContext } from "./draft.ts";
import { SessionHub } from "./events.ts";
import { loadConfig, llm, modelsCollection, resolveModel, setModelsForTest } from "./llm.ts";
import { mqmTable } from "./mqm.ts";
import { projectMessages } from "./projection.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { publishDraft } from "./publish.ts";
import { SessionRuntime } from "./runner.ts";
import { SessionStore, summarize, LOCAL_NAME_PATTERN, type SessionMeta, type SessionRecord } from "./sessions.ts";
import { buildTools } from "./tools/index.ts";

export { llm, setModelsForTest };

const log = logger("agent");
const store = new SessionStore();
const hub = new SessionHub();
const runtimes = new Map<string, SessionRuntime>();
const runs = new Map<string, Promise<void>>();
const active = new Set<string>();
const pendingAborts = new Set<string>();
const MAX_LOCAL_FILE_BYTES = 256 * 1024;
const MAX_LOCAL_TOTAL_BYTES = 1024 * 1024;

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

function detailOf(record: SessionRecord): SessionDetail {
  const meta = record.meta;
  const draft = parseDraftFile(record.local?.[DRAFT_FILE]?.content);
  return {
    ...summarize(record),
    items: projectMessages(record.messages),
    ...(draft === null ? {} : { draft }),
    ...(meta.headSha ? { headSha: meta.headSha } : {}),
    ...(meta.stale ? { stale: true } : {}),
  };
}

function toolContext(record: SessionRecord): ToolContext {
  const id = record.meta.id;
  const keyOf = (prNumber: number, headSha: string): string => `${prNumber}@${headSha}`;
  return {
    sessionId: id,
    prNumber: record.meta.prNumber ?? null,
    baseSha: record.meta.baseSha ?? null,
    headSha: record.meta.headSha ?? null,
    writeScope: record.meta.writeScope,
    evalScope: record.meta.evalScope,
    local: async (name) => (await store.get(id))?.local?.[name] ?? null,
    saveLocal: async (name, content) => {
      if (!LOCAL_NAME_PATTERN.test(name)) {
        throw new Error("本地文件名无效：只能是 1-64 位字母、数字、点、下划线或连字符。");
      }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_LOCAL_FILE_BYTES) throw new Error("本地文件超过 256 KiB 上限。");
      const current = await store.get(id);
      if (!current) throw new Error("会话不存在");
      const previous = current.local?.[name];
      const total =
        Object.values(current.local ?? {}).reduce((sum, entry) => sum + Buffer.byteLength(entry.content, "utf8"), 0) -
        (previous === undefined ? 0 : Buffer.byteLength(previous.content, "utf8")) +
        bytes;
      if (total > MAX_LOCAL_TOTAL_BYTES) throw new Error("会话本地文件总量超过 1 MiB 上限。");
      const entry = { content, updatedAt: now() };
      current.local = { ...(current.local ?? {}), [name]: entry };
      current.meta.updatedAt = entry.updatedAt;
      await store.put(current);
      return entry;
    },
    listLocal: async () => {
      const current = await store.get(id);
      return Object.entries(current?.local ?? {})
        .map(([name, entry]) => ({
          name,
          size: Buffer.byteLength(entry.content, "utf8"),
          updatedAt: entry.updatedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    packFor: async (prNumber, headSha) => {
      const current = await store.get(id);
      if (!current) return null;
      const packed = current.packs?.[keyOf(prNumber, headSha)];
      if (packed) return packed;
      const legacy = current.pack;
      return legacy && legacy.prNumber === prNumber && legacy.headSha === headSha ? legacy : null;
    },
    savePackFor: async (prNumber, headSha, pack) => {
      const current = await store.get(id);
      if (!current) throw new Error("会话不存在");
      const packs = { ...(current.packs ?? {}), [keyOf(prNumber, headSha)]: pack };
      const keys = Object.keys(packs);
      while (keys.length > 2) {
        const oldest = keys.shift();
        if (oldest !== undefined) delete packs[oldest];
      }
      current.packs = packs;
      if (prNumber === current.meta.prNumber) current.pack = pack;
      current.meta.updatedAt = now();
      await store.put(current);
    },
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
  let messages: AgentMessage[] | undefined;
  const earlyAbort = pendingAborts.has(id);
  pendingAborts.delete(id);
  try {
    const record = await store.get(id);
    if (!record) return;
    const systemPrompt = await buildSystemPrompt(record.meta.review);
    const { model, apiKey, endpoint } = await resolveModel(record.meta.model);
    const collection = await modelsCollection();
    const runtime = new SessionRuntime({
      sessionId: id,
      model,
      apiKey,
      systemPrompt,
      messages: record.messages.slice(0, -1),
      tools: buildTools(toolContext(record)),
      thinking: endpoint?.thinking,
      collection,
      onItem: (item) => hub.emit(id, { type: "item", item }),
    });
    runtimes.set(id, runtime);
    if (earlyAbort || pendingAborts.delete(id)) {
      runtime.abort();
      return;
    }
    const outcome = await runtime.run(prompt);
    if (!outcome.aborted) error = outcome.error;
    messages = outcome.messages;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error("会话运行失败", { id, err });
  } finally {
    runtimes.delete(id);
    active.delete(id);
    const fresh = await store.get(id).catch(() => null);
    if (fresh) {
      if (messages) fresh.messages = messages;
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
    const message: AgentMessage = { role: "user", content: prompt, timestamp: Date.now() };
    record.messages.push(message);
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
    return record ? detailOf(record) : null;
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
    const writeScope: WriteScope =
      request.writeScope === "bound" && request.prNumber === undefined ? "off" : (request.writeScope ?? "off");
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
    await store.put({ meta, messages: [] });
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
      runtime.abort();
      return;
    }
    if (active.has(id)) pendingAborts.add(id);
  },

  async archive(id: string): Promise<void> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    if (record.meta.status === "running") runtimes.get(id)?.abort();
    record.meta.archived = true;
    record.meta.updatedAt = now();
    await store.put(record);
  },

  subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
    const record = store.peek(id);
    if (record) listener({ type: "snapshot", session: detailOf(record) });
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
    record.local = {
      ...(record.local ?? {}),
      [DRAFT_FILE]: { content: serializeDraftFile(next), updatedAt: next.updatedAt },
    };
    record.meta.updatedAt = next.updatedAt;
    await store.put(record);
    hub.emit(id, { type: "draft", draft: next });
    return next;
  },

  async publish(id: string, by: string): Promise<{ url: string }> {
    const record = await store.get(id);
    if (!record) throw httpError("会话不存在", 404);
    const draft = parseDraftFile(record.local?.[DRAFT_FILE]?.content);
    if (draft === null) throw httpError("没有可发布的审查草稿", 400);
    if (record.meta.stale) throw httpError("PR 已有新的提交，草稿已过期，请重新审查后再发布", 409);
    if (record.meta.prNumber !== undefined && record.meta.prNumber !== draft.prNumber) {
      throw httpError("草稿的 PR 与当前会话绑定的 PR 不一致", 409);
    }
    const { url } = await publishDraft(draft);
    const publishedAt = now();
    const published: ReviewDraft = { ...draft, publishedAt, publishedUrl: url };
    record.local = {
      ...(record.local ?? {}),
      [DRAFT_FILE]: { content: serializeDraftFile(published), updatedAt: publishedAt },
    };
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

  async markStale(prNumber: number, headSha: string): Promise<void> {
    for (const record of store.all()) {
      if (record.meta.prNumber !== prNumber || record.meta.headSha === undefined) continue;
      const stale = record.meta.headSha !== headSha;
      if (record.meta.stale === stale) continue;
      record.meta.stale = stale;
      record.meta.updatedAt = now();
      await store.put(record);
    }
  },

  async shutdown(): Promise<void> {
    for (const runtime of runtimes.values()) runtime.abort();
    await Promise.allSettled([...runs.values()]);
    runtimes.clear();
  },
};
