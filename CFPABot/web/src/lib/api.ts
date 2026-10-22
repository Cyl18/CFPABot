import type {
  AddReviewCommentRequest,
  AddReviewReplyRequest,
  CheckReport,
  CompareResult,
  CreateSessionRequest,
  CrossVersionKeysResult,
  LlmConfigUpdate,
  LlmConfigView,
  LogEntry,
  LogLevel,
  MappingEntry,
  Me,
  ModList,
  PackSummary,
  PrDetail,
  PrReviewState,
  PrState,
  PrSummary,
  ProbeModelsRequest,
  ReviewComment,
  ReviewHtmlRequest,
  ReviewHtmlResult,
  ReviewThread,
  SessionDetail,
  SessionSummary,
  SetEvalScopeRequest,
  SetFileViewedRequest,
  SetThreadResolvedRequest,
  SetWriteScopeRequest,
  SpecialPair,
  SpecialPairContent,
  SubmitReviewRequest,
  SystemStatus,
  TextCompareRequest,
  TextCompareResult,
} from "@shared/api.ts";

const TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function loginUrl(next?: string): string {
  const target = next ?? (typeof window === "undefined" ? "/" : window.location.pathname + window.location.search);
  return `/auth/login?next=${encodeURIComponent(target)}`;
}

function errorEnvelope(body: unknown, status: number): { message: string; code?: string } {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : null;
    if (message !== null) {
      return typeof record.code === "string" ? { message, code: record.code } : { message };
    }
  }
  return { message: `请求失败（HTTP ${status}）` };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const envelope = errorEnvelope(body, response.status);
    throw new ApiError(response.status, envelope.message, envelope.code);
  }
  return body as T;
}

function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, signal ? { signal } : {});
}

function send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
  });
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
}

export interface CompareKey {
  slug: string;
  version: string;
  namespace: string;
}

export function parseWorkspaceKey(key: string): CompareKey | null {
  const parts = key.split("/");
  if (parts.length !== 3) return null;
  const [slug, version, namespace] = parts;
  if (!slug || !version || !namespace) return null;
  return { slug, version, namespace };
}

export const api = {
  me: (signal?: AbortSignal) => get<Me | null>("/api/me", signal),
  status: (signal?: AbortSignal) => get<SystemStatus>("/api/status", signal),

  prs: (state: PrState | "all", signal?: AbortSignal) => get<PrSummary[]>(`/api/prs${query({ state })}`, signal),
  pr: (n: number, signal?: AbortSignal) => get<PrDetail>(`/api/prs/${n}`, signal),
  checks: (n: number, signal?: AbortSignal) => get<CheckReport | null>(`/api/prs/${n}/checks`, signal),
  pack: (n: number, signal?: AbortSignal) => get<PackSummary>(`/api/prs/${n}/pack`, signal),
  refreshPr: (n: number) => send<{ ok: true }>("POST", `/api/prs/${n}/refresh`),
  refreshStatus: (n: number, signal?: AbortSignal) => get<{ running: boolean }>(`/api/prs/${n}/refresh/status`, signal),
  compare: (n: number, key: CompareKey, signal?: AbortSignal) =>
    get<CompareResult>(`/api/prs/${n}/compare${query({ slug: key.slug, version: key.version, namespace: key.namespace })}`, signal),
  special: (n: number, signal?: AbortSignal) => get<SpecialPair[]>(`/api/prs/${n}/special`, signal),
  specialContent: (n: number, key: string, signal?: AbortSignal) =>
    get<SpecialPairContent>(`/api/prs/${n}/special/content${query({ key })}`, signal),
  review: (n: number, signal?: AbortSignal) => get<PrReviewState>(`/api/prs/${n}/review`, signal),
  addReviewComment: (n: number, body: AddReviewCommentRequest) => send<ReviewThread>("POST", `/api/prs/${n}/review/comments`, body),
  deleteReviewComment: (n: number, id: string) => send<void>("DELETE", `/api/prs/${n}/review/comments/${encodeURIComponent(id)}`),
  setThreadResolved: (n: number, id: string, body: SetThreadResolvedRequest) =>
    send<void>("PUT", `/api/prs/${n}/review/threads/${encodeURIComponent(id)}/resolved`, body),
  reviewHtml: (n: number, body: ReviewHtmlRequest) => send<ReviewHtmlResult>("POST", `/api/prs/${n}/review/html`, body),
  addReviewReply: (n: number, id: string, body: AddReviewReplyRequest) =>
    send<ReviewComment>("POST", `/api/prs/${n}/review/threads/${encodeURIComponent(id)}/replies`, body),
  setFileViewed: (n: number, body: SetFileViewedRequest) => send<void>("PUT", `/api/prs/${n}/review/viewed`, body),
  submitReview: (n: number, body: SubmitReviewRequest) => send<{ url: string }>("POST", `/api/prs/${n}/review/submit`, body),
  versionsKeys: (
    slug: string,
    opts: { namespace?: string; pr?: number; versions?: readonly string[] },
    signal?: AbortSignal,
  ) =>
    get<CrossVersionKeysResult>(
      `/api/versions/${encodeURIComponent(slug)}/keys${query({
        namespace: opts.namespace,
        pr: opts.pr,
        versions: opts.versions === undefined || opts.versions.length === 0 ? undefined : opts.versions.join(","),
      })}`,
      signal,
    ),
  compareText: (body: TextCompareRequest) => send<TextCompareResult>("POST", "/api/compare/text", body),
  mods: (q: string, signal?: AbortSignal) => get<ModList>(`/api/mods${query({ q })}`, signal),

  sessions: (signal?: AbortSignal) => get<SessionSummary[]>("/api/sessions", signal),
  session: (id: string, signal?: AbortSignal) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`, signal),
  createSession: (body: CreateSessionRequest) => send<SessionDetail>("POST", "/api/sessions", body),
  sendMessage: (id: string, text: string) => send<{ ok: true }>("POST", `/api/sessions/${encodeURIComponent(id)}/messages`, { text }),
  abortSession: (id: string) => send<{ ok: true }>("POST", `/api/sessions/${encodeURIComponent(id)}/abort`),
  archiveSession: (id: string) => send<{ ok: true }>("POST", `/api/sessions/${encodeURIComponent(id)}/archive`),
  setSessionWriteScope: (id: string, body: SetWriteScopeRequest) =>
    send<{ ok: true; writeScope: string }>("PATCH", `/api/sessions/${encodeURIComponent(id)}/write-scope`, body),
  setSessionEvalScope: (id: string, body: SetEvalScopeRequest) =>
    send<{ ok: true; evalScope: string }>("PATCH", `/api/sessions/${encodeURIComponent(id)}/eval-scope`, body),
  saveArtifact: (id: string, value: unknown) =>
    send<unknown>("PUT", `/api/sessions/${encodeURIComponent(id)}/artifact`, value),
  readArtifact: (id: string) => get<unknown>(`/api/sessions/${encodeURIComponent(id)}/artifact`),
  publishArtifact: (id: string) => send<{ url: string }>("POST", `/api/sessions/${encodeURIComponent(id)}/publish`, {}),
  sessionEventsUrl: (id: string) => `/api/sessions/${encodeURIComponent(id)}/events`,

  llm: (signal?: AbortSignal) => get<LlmConfigView>("/api/admin/llm", signal),
  updateLlm: (body: LlmConfigUpdate) => send<LlmConfigView>("PUT", "/api/admin/llm", body),
  testLlm: (endpointId: string) => send<{ ok: boolean; reply?: string; error?: string }>("POST", "/api/admin/llm/test", { endpointId }),
  probeModels: (body: ProbeModelsRequest) => send<{ models: string[] }>("POST", "/api/admin/llm/probe", body),

  logs: (level: LogLevel | "all", limit: number, signal?: AbortSignal) =>
    get<LogEntry[]>(`/api/admin/logs${query({ level: level === "all" ? undefined : level, limit })}`, signal),
  mappings: (signal?: AbortSignal) => get<{ mappings: MappingEntry[]; unmapped: string[] }>("/api/admin/mappings", signal),
  addMapping: (slug: string, curseforgeId: number) => send<{ ok: true }>("PUT", "/api/admin/mappings", { slug, curseforgeId }),
  refreshCache: (what: "prs" | "mirror" | "mappings" | "glossary") => send<{ ok: true }>("POST", `/api/admin/cache/${what}`),
};

export type Api = typeof api;
