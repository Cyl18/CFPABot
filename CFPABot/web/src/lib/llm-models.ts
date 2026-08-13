// Pure helpers for live OpenAI-compatible model discovery.
// The browser-side fetch path (fetchLiveModels) was removed — admin "拉取端点模型"
// now goes through the backend proxy (src/client/llm-models.ts) to dodge CORS.
//
// Mirror of the server-side pure helpers in src/client/llm-models.ts.
// Keep these in sync (same normalize/infer rules) so the admin form can guess
// the protocol + normalize the root before the value ever hits the backend.

import type { LlmProtocol, LlmEndpointResponse } from './api'

// ─── URL normalization & protocol inference ─────────────────────

/**
 * Endpoint suffixes to strip when normalizing an LLM baseUrl to its API root.
 * ORDER MATTERS: longest-first so `/chat/completions` is stripped before the
 * generic `/completions`. Version segments (/v1, /v3, /api/coding/v3) are kept.
 */
const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/messages',
  '/responses',
  '/models',
] as const

/** models.dev 索引请求超时(ms) */
const MODELS_DEV_TIMEOUT_MS = 15_000

/**
 * Normalize an LLM baseUrl to its API root by stripping only endpoint suffixes
 * (and trailing slashes). Version segments and any other path are preserved.
 * Strips iteratively so a double-tailed input collapses to the root in one call.
 */
export function normalizeLlmBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (url.toLowerCase().endsWith(suffix)) {
        url = url.slice(0, -suffix.length).replace(/\/+$/, '')
        changed = true
        break
      }
    }
  }
  return url
}

/**
 * Infer the LLM protocol from a (possibly full, endpoint-tailed) URL, BEFORE
 * normalization strips the hints. Returns undefined when there is no keyword,
 * so the caller can let the user pick the protocol.
 */
export function inferProtocolFromUrl(raw: string): LlmProtocol | undefined {
  const lower = raw.toLowerCase()
  if (lower.includes('/chat/completions')) return 'openai-completions'
  if (lower.includes('/responses')) return 'openai-responses'
  if (lower.includes('/messages')) return 'anthropic-messages'
  if (lower.includes('/completions')) return 'openai-completions'
  if (/generativelanguage\.googleapis\.com/.test(lower)) return 'google-generative-ai'
  if (/\/v1beta/.test(lower)) return 'google-generative-ai'
  if (/\bgemini\b/.test(lower)) return 'google-generative-ai'
  return undefined
}

// ─── models.dev limit matching ───────────────────────────────────

/** A models.dev limit shape (subset used for enrichment). */
export interface ModelsDevLimitInfo {
  context?: number
  input?: number
  output?: number
}

/** Limits to auto-fill when a live model id matches a models.dev entry. */
export interface ModelsDevMatch {
  inputLimit?: number
  maxOutputTokens?: number
}

/**
 * Find models.dev limits for a given model id. Matches purely on model id
 * (ids are typically unique across providers). Returns undefined if no match.
 */
export function pickModelLimits(
  index: ReadonlyArray<{ model: { id: string; limit?: ModelsDevLimitInfo } }>,
  modelId: string,
): ModelsDevMatch | undefined {
  const entry = index.find((e) => e.model.id === modelId)
  if (!entry) return undefined
  const limit = entry.model.limit
  if (!limit) return undefined
  return {
    inputLimit: limit.context ?? limit.input,
    maxOutputTokens: limit.output,
  }
}

// ─── models.dev cache layer ──────────────────────────────────────

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const CACHE_TTL = 10 * 60 * 1000 // 10 minutes
export const STORAGE_KEY = 'cfpa.models-dev.index.v1'

export interface ModelsDevModel {
  id: string
  name?: string
  limit?: ModelsDevLimitInfo
  input?: string[]
  output?: string[]
}

export interface ModelsDevProvider {
  id: string
  name?: string
  api?: string
  models: Record<string, ModelsDevModel>
}

export type ModelsDevIndex = Record<string, ModelsDevProvider>

/** A flat, searchable entry: one per (provider, model) pair. */
export interface FlatModelEntry {
  providerKey: string
  providerName: string
  providerApi: string | undefined
  model: ModelsDevModel
}

export function flattenModelsDevIndex(index: ModelsDevIndex): FlatModelEntry[] {
  const out: FlatModelEntry[] = []
  for (const [key, prov] of Object.entries(index)) {
    if (!prov || typeof prov !== 'object') continue
    const models = prov.models
    if (!models || typeof models !== 'object') continue
    const provName = String(prov.name ?? key)
    const provApi = prov.api
    for (const [modelId, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object') continue
      if (!model.limit) continue
      const id = model.id || modelId
      if (!id) continue
      out.push({ providerKey: key, providerName: provName, providerApi: provApi, model: { ...model, id } })
    }
  }
  return out
}

export interface ModelsDevPersist {
  entries: FlatModelEntry[]
  fetchedAt: number
}

export function loadFromStorage(): ModelsDevPersist | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ModelsDevPersist
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveToStorage(entries: FlatModelEntry[]): void {
  try {
    const payload: ModelsDevPersist = { entries, fetchedAt: Date.now() }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // storage full or unavailable — ignore, memory cache still works
  }
}

let _modelsDevCache: FlatModelEntry[] | null = null
let _modelsDevExpiresAt = 0
let _modelsDevInFlight: Promise<FlatModelEntry[] | null> | null = null

/**
 * Fetch models.dev model index, with layered cache:
 *   memory (fresh TTL) → localStorage (within TTL or stale fallback)
 *   → network → on success write both. Returns parsed entries or null
 *   on failure; never throws when any cache exists.
 */
export async function fetchModelsDevModels(): Promise<FlatModelEntry[] | null> {
  const now = Date.now()

  if (_modelsDevCache && now < _modelsDevExpiresAt) {
    return _modelsDevCache
  }

  const persisted = loadFromStorage()
  if (persisted && now < persisted.fetchedAt + CACHE_TTL) {
    _modelsDevCache = persisted.entries
    _modelsDevExpiresAt = persisted.fetchedAt + CACHE_TTL
    return persisted.entries
  }

  if (_modelsDevInFlight) return _modelsDevInFlight

  _modelsDevInFlight = (async (): Promise<FlatModelEntry[] | null> => {
    try {
      const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ModelsDevIndex
      const entries = flattenModelsDevIndex(data)
      _modelsDevCache = entries
      _modelsDevExpiresAt = Date.now() + CACHE_TTL
      saveToStorage(entries)
      return entries
    } catch (err) {
      if (_modelsDevCache) return _modelsDevCache
      if (persisted) return persisted.entries
      throw err
    } finally {
      _modelsDevInFlight = null
    }
  })()

  return _modelsDevInFlight
}

// ─── Provider presets ────────────────────────────────────────────

export interface ProviderPreset {
  slug: string
  label: string
  baseUrl: string
  protocol: LlmProtocol
}

/** Built-in provider presets. slug is the stored `provider` value; label is the UI display. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { slug: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' },
  { slug: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages' },
  { slug: 'google', label: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'google-generative-ai' },
  { slug: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-completions' },
  { slug: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions' },
  { slug: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai-completions' },
  { slug: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1', protocol: 'openai-completions' },
  { slug: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai-completions' },
  { slug: 'moonshot', label: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai-completions' },
  { slug: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai-completions' },
  // Same root for OpenAI-compat and Anthropic; default protocol openai-completions — user can switch Protocol to anthropic-messages.
  { slug: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', protocol: 'openai-completions' },
]

/** Build a sensible default baseUrl for common providers. */
export const DEFAULT_BASE_URLS: Record<string, string> = Object.fromEntries(
  PROVIDER_PRESETS.map((p) => [p.slug, p.baseUrl]),
)

/** Default protocol per provider when protocol is not explicitly set. */
export const DEFAULT_PROTOCOLS: Partial<Record<string, LlmProtocol>> = Object.fromEntries(
  PROVIDER_PRESETS.map((p) => [p.slug, p.protocol]),
)

export const KNOWN_PROTOCOLS: LlmProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]

// ─── Form helpers ────────────────────────────────────────────────

/** Empty form initializer. */
export const EMPTY_FORM: LlmEndpointResponse = {
  provider: '',
  baseUrl: '',
  apiKey: '',
  hasApiKey: false,
  modelId: '',
}

/** Format a model ref as a compact string for <select> value. */
export function formatModelRef(ref: { provider: string; modelId: string } | undefined): string {
  if (!ref || !ref.provider || !ref.modelId) return ""
  return `${ref.provider}/${ref.modelId}`
}

/** Parse a compact "provider/modelId" string back to a model ref. Returns null on empty/invalid. */
export function parseModelRef(value: string): { provider: string; modelId: string } | null {
  if (!value) return null
  const slashIdx = value.indexOf("/")
  if (slashIdx === -1) return null
  const provider = value.slice(0, slashIdx)
  const modelId = value.slice(slashIdx + 1)
  if (!provider || !modelId) return null
  return { provider, modelId }
}
