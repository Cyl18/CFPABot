// ---- Shared types for the API layer -------------------------------

/** Thinking/reasoning level. Verbatim from @earendil-works/pi-agent-core. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Thrown when a 401 redirects to OAuth so callers can distinguish from network errors. */
export class AuthError extends Error {
  constructor() { super('Authentication required'); this.name = 'AuthError'; }
}

export interface Pr {
  number: number
  title: string
  author: string
  status: string
  labels?: { name: string }[]
  created_at?: string
  createdDate?: string
  merged_at?: string
  modCount?: number
}

export interface PrFile {
  path: string
  additions: number
  deletions: number
  language: string
}

export interface PrMod {
  slug: string
  name: string
  version: string
}

export interface PrDetail {
  prNumber: number
  title: string
  htmlUrl: string
  state: 'open' | 'closed'
  draft: boolean
  author: { login: string; id: number } | null
  labels: string[]
  head: { sha: string; ref: string }
  base: { sha: string; ref: string }
  createdAt: string
  updatedAt: string
  changedFiles: number
  files: Array<{ path: string; status: string; additions: number; deletions: number }>
  workflows: {
    name: string
    status: string
    conclusion: string | null
    htmlUrl: string | null
  }[]
}

export interface DiffRow {
  key: string
  oldEnglish: string
  newEnglish: string
  oldChinese: string
  newChinese: string
  status: 'new' | 'modified' | 'removed' | 'unchanged'
  termCheck: 'ok' | 'warning' | 'error'
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  data: Record<string, unknown>
}

export interface RateLimitResponse {
  resources: {
    core: { limit: number; remaining: number; reset: number; used: number }
    search: { limit: number; remaining: number; reset: number; used: number }
  }
  rate: { limit: number; remaining: number; reset: number; used: number }
}

export interface OutboundCall {
  id: number
  timestamp: number
  method: string
  args: unknown[]
  result?: unknown
}

export interface UnmappedSlugInfo {
  slug: string;
  versions: string[];
}
export interface UnmappedSlugsResponse {
  total: number;
  totalModlistEntries: number;
  mappedCount: number;
  lastScannedId: number;
  mappingUpdatedAt: string;
  slugs: UnmappedSlugInfo[];
  error?: string;
}

export type LlmProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

/** Response from GET — includes UI-only hasApiKey metadata. */
export interface LlmEndpointResponse {
  provider: string;
  protocol?: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  modelId: string;
  inputLimit?: number;
  maxOutputTokens?: number;
}

/** Input for PUT — only persisted fields (no hasApiKey). */
export interface LlmEndpointInput {
  provider: string;
  protocol?: LlmProtocol;
  baseUrl: string;
  apiKey?: string;
  modelId?: string;
  inputLimit?: number;
  maxOutputTokens?: number;
}

export interface LlmDefaultsResponse {
  sessionModel?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
  reviewModelSet?: Array<{ provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>
}

export interface LlmDefaultsInput {
  sessionModel?: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
  reviewModelSet?: Array<{ provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>
}

export interface AgentSession {
  sessionId: string
  status: string
  createdAt: string
  messageCount: number
  modelId?: string
  modelProvider?: string
  prNumber?: number
  objective?: string
  /** 前端在 failed 事件时注入的会话级错误(后端列表 DTO 不含此字段) */
  error?: string
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  timestamp?: string
  thinking?: string
  toolName?: string
}

export interface PendingConfirmation {
  toolCallId: string
  flowName: string
  input?: unknown
}

/** Normalize a backend role string to the frontend AgentMessage role union. */
export function normalizeRole(role: string): AgentMessage['role'] | undefined {
  switch (role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    // pi-agent 实时事件使用 toolResult,历史接口映射为 tool —— 两路径对齐
    case 'toolResult':
    case 'tool': return 'tool'
    case 'system': return 'system'
    default: return undefined
  }
}

export interface CompareUploadResponse {
  rows: DiffRow[]
  summary: { total: number; new: number; modified: number; removed: number; unchanged: number }
}

export type WorkspaceCompareStatus = 'add' | 'remove' | 'modify' | 'unchanged'

export interface CompareWorkspaceRow {
  key: string
  oldEnglish: string
  newEnglish: string
  oldChinese: string
  newChinese: string
  enStatus: WorkspaceCompareStatus
  zhStatus: WorkspaceCompareStatus
}

export interface WorkspaceCompareSummary {
  total: number
  en: { add: number; remove: number; modify: number; unchanged: number }
  zh: { add: number; remove: number; modify: number; unchanged: number }
}

export interface CompareWorkspaceRequest {
  slug: string
  version: string
  namespace: string
}

export interface CompareWorkspaceResponse {
  rows: CompareWorkspaceRow[]
  summary: WorkspaceCompareSummary
  meta: {
    workspace: { slug: string; version: string; namespace: string }
    baseSha: string
    headSha: string
    missingFiles: string[]
  }
}

export interface CrossVersionCell {
  en: string
  zh: string
  enPresent: boolean
  zhPresent: boolean
}

export interface CrossVersionRow {
  key: string
  versions: Record<string, CrossVersionCell>
  enConsistent: boolean
  zhConsistent: boolean
  enSameZhDiffers: boolean
  presentCount: number
  totalVersions: number
}

export interface CrossVersionSummary {
  totalKeys: number
  enConsistentKeys: number
  zhConsistentKeys: number
  enSameZhDiffersKeys: number
}

export interface CrossVersionResponse {
  slug: string
  namespace: string
  versions: string[]
  rows: CrossVersionRow[]
  summary: CrossVersionSummary
  prFiltered?: boolean
}
