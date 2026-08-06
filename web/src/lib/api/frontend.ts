import { apiGet, apiPost, apiPostJson, apiPut, apiDel, transport, throwApiError } from './client'
import type {
  Pr,
  PrDetail,
  LogEntry,
  CompareWorkspaceRequest,
  CompareWorkspaceResponse,
  CompareUploadResponse,
  CrossVersionResponse,
  LlmEndpointResponse,
  LlmEndpointInput,
  LlmDefaultsResponse,
  LlmDefaultsInput,
  ThinkingLevel,
  OutboundCall,
  UnmappedSlugsResponse,
  RateLimitResponse,
  WorkspaceCompareStatus,
} from './types'

const BASE = '/api/frontend'

export const api = {
  getMe: () => apiGet<{ login: string; id: number; avatar?: string; isAdmin: boolean; isContributor: boolean } | null>('/me', BASE),
  getPrs: (state = 'all') => apiGet<Pr[]>(`/prs?state=${state}`, BASE),
  getPr: (number: number) => apiGet<PrDetail>(`/pr/${number}`, BASE),
  getLogs: (level?: string, limit?: number) => {
    const params = new URLSearchParams()
    if (level) params.set('level', level)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString()
    return apiGet<LogEntry[]>(`/logs${qs ? `?${qs}` : ''}`, BASE)
  },
  compareWorkspace: (prId: number, data: CompareWorkspaceRequest) =>
    apiPost<CompareWorkspaceResponse>(`/compare/${prId}/workspace`, data, BASE),
  getCompareWorkspaces: (prId: number) =>
    apiGet<{ slugs: string[]; workspaces: Array<{ slug: string; version: string; namespace: string; files: string[] }> }>(
      `/compare/${prId}/workspaces`,
      BASE,
    ),
  getCrossVersion: (slug: string, namespace?: string, prId?: number) => {
    const params = new URLSearchParams()
    if (namespace) params.set('namespace', namespace)
    if (prId !== undefined) params.set('pr', String(prId))
    const qs = params.toString()
    return apiGet<CrossVersionResponse>(`/compare/versions/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`, BASE)
  },
  compareUpload: async (fileA: File, fileB: File): Promise<CompareUploadResponse> => {
    const formData = new FormData()
    formData.append('fileA', fileA)
    formData.append('fileB', fileB)
    // 复用共享 transport:统一超时、401 处理与错误信封解析
    const res = await transport('/compare/upload', { method: 'POST', body: formData }, BASE)
    if (!res.ok) throw await throwApiError(res)
    return res.json()
  },
  refreshPrsCache: () => apiPost<{ message: string }>('/refresh-prs-cache', {}, BASE),
  getSpecialDiff: (prId: number) => apiGet<{ files: Array<{ path: string; status: string; baseContent: string; headContent: string }> }>(`/compare/${prId}/special-diff`, BASE),

  // LLM endpoint config
  getLlmEndpoints: () => apiGet<{ endpoints: LlmEndpointResponse[]; defaults?: LlmDefaultsResponse }>('/admin/llm-endpoints', BASE),
  saveLlmEndpoints: (endpoints: LlmEndpointResponse[], defaults?: LlmDefaultsResponse) => {
    const payload: { endpoints: LlmEndpointInput[]; defaults?: LlmDefaultsInput } = {
      endpoints: endpoints.map((ep) => ({
        provider: ep.provider,
        protocol: ep.protocol,
        baseUrl: ep.baseUrl,
        apiKey: ep.apiKey,
        modelId: ep.modelId,
        inputLimit: ep.inputLimit,
        maxOutputTokens: ep.maxOutputTokens,
      })),
      ...(defaults ? { defaults: {
        ...(defaults.sessionModel ? { sessionModel: { provider: defaults.sessionModel.provider, modelId: defaults.sessionModel.modelId, ...(defaults.sessionModel.thinkingLevel != null ? { thinkingLevel: defaults.sessionModel.thinkingLevel } : {}) } } : {}),
        ...(defaults.reviewModelSet ? { reviewModelSet: defaults.reviewModelSet.map((m) => ({ provider: m.provider, modelId: m.modelId, ...(m.thinkingLevel != null ? { thinkingLevel: m.thinkingLevel } : {}) })) } : {}),
      } } : {}),
    }
    return apiPut<{ ok: boolean }>('/admin/llm-endpoints', payload, BASE)
  },
  probeLlmModels: (baseUrl: string, apiKey: string, protocol?: string) =>
    apiPostJson<{ models: string[] } | { error: string; detail?: string }>(
      "/admin/llm-endpoints/probe-models",
      { baseUrl, apiKey, ...(protocol ? { protocol } : {}) },
      BASE,
    ),
  /** Probe a saved endpoint's /models using the stored apiKey (edit mode, key not echoed). */
  probeLlmModelsRef: (provider: string, modelId: string, baseUrl?: string, protocol?: string) =>
    apiPostJson<{ models: string[] } | { error: string; detail?: string }>(
      "/admin/llm-endpoints/probe-models",
      {
        ref: { provider, modelId },
        ...(baseUrl ? { baseUrl } : {}),
        ...(protocol ? { protocol } : {}),
      },
      BASE,
    ),
  testLlmEndpoint: (provider: string, modelId: string) =>
    apiPostJson<{ ok: boolean; reply?: string } | { ok: false; error: string }>(
      "/admin/llm-endpoints/test",
      { provider, modelId },
      BASE,
    ),

  // Developer Panel — mock webhook testing
  getOutboundCalls: () => apiGet<{ calls: OutboundCall[]; active: boolean }>('/dev/outbound-calls', BASE),
  clearOutboundCalls: () => apiDel<{ cleared: boolean }>('/dev/outbound-calls', BASE),
  getMockConfig: () => apiGet<{ overrides: Record<string, unknown>; active: boolean }>('/dev/mock-config', BASE),
  setMockOverride: (method: string, result: unknown) =>
    apiPut<{ ok: true; overrides: Record<string, unknown> }>('/dev/mock-config', { method, result }, BASE),
  clearMockOverride: (method: string) =>
    apiDel<{ ok: true; overrides: Record<string, unknown> }>(`/dev/mock-config/${encodeURIComponent(method)}`, BASE),
  clearAllMockOverrides: () => apiDel<{ ok: true; overrides: Record<string, unknown> }>('/dev/mock-config', BASE),
  mockWebhook: (eventType: string, prId: number, payload?: Record<string, unknown>) =>
    apiPost<{ ok: boolean; message: string; prId: number; eventType: string; tip: string }>('/dev/mock-webhook', { eventType, prId, payload }, BASE),
  getUnmappedSlugs: () => apiGet<UnmappedSlugsResponse>('/dev/unmapped-slugs', BASE),
  getEventTypes: () => apiGet<{ eventTypes: string[] }>('/dev/event-types', BASE),
  getRateLimit: () => apiGet<RateLimitResponse>('/rate-limit', BASE),
}
