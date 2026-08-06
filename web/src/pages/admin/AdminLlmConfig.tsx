import { Link } from "react-router-dom"

import { useState, useEffect, useRef } from 'react'
import { Bot, Plus, X, AlertTriangle, Check, Cpu, RefreshCw } from 'lucide-react'
import { api, type LlmEndpointResponse, type LlmDefaultsResponse } from '@/lib/api'
import {
  type FlatModelEntry,
  EMPTY_FORM,
  fetchModelsDevModels,
} from '@/lib/llm-models'
import { getErrorMessage } from '@/lib/helpers'
import AdminLlmForm from './AdminLlmForm'
import AgentDefaultsSection from './AgentDefaultsSection'

/** 成功提示展示时长(ms) */
const SUCCESS_BANNER_MS = 3000

export default function AdminLlmConfig() {
  const [endpoints, setEndpoints] = useState<LlmEndpointResponse[]>([])
  const [defaults, setDefaults] = useState<LlmDefaultsResponse | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  // False until a GET succeeds — guards persist() against overwriting the on-disk
  // config with a truncated list after a failed initial load.
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  /** 成功提示定时器:卸载时清理,连续保存时只保留最后一个 */
  const successTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    clearTimeout(successTimer.current)
  }, [])

  // Add/edit form
  const [showForm, setShowForm] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [form, setForm] = useState<LlmEndpointResponse>({ ...EMPTY_FORM })

  // models.dev state
  const [modelsDevIndex, setModelsDevIndex] = useState<FlatModelEntry[] | null>(null)


  // Load endpoints + defaults on mount; warm models.dev for silent limits only.
  useEffect(() => {
    loadConfig()
    void ensureModelsDevIndex()
  }, [])


  async function loadConfig() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.getLlmEndpoints()
      setEndpoints(res.endpoints)
      setDefaults(res.defaults)
      setLoaded(true)
    } catch (err) {
      setLoaded(false)
      setError(`加载配置失败: ${getErrorMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }

  /** Lazy-load models.dev index from URL via module-level cache. */
  async function ensureModelsDevIndex() {
    try {
      const idx = await fetchModelsDevModels()
      if (idx) {
        setModelsDevIndex(idx)
      }
      return idx
    } catch (err) {
      return null
    }
  }

  function openAddForm() {
    setEditIndex(null)
    setForm({ ...EMPTY_FORM })
    setShowForm(true)
  }

  function openEditForm(idx: number) {
    setEditIndex(idx)
    const ep = endpoints[idx]
    setForm({ ...ep })
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setEditIndex(null)
    setForm({ ...EMPTY_FORM })
  }

  /**
   * Handle save from the child form: merge one-or-many saved endpoints into the
   * list and persist immediately (auto-save; single-admin flow).
   * Resolves true when the write succeeded.
   */
  async function handleFormSave(saved: LlmEndpointResponse[]): Promise<boolean> {
    let next: LlmEndpointResponse[]
    if (editIndex !== null && saved.length === 1) {
      next = [...endpoints]
      next[editIndex] = { ...saved[0]! }
    } else {
      // Add mode: find existing identity and update in place, or push.
      next = [...endpoints]
      for (const s of saved) {
        const existingIdx = next.findIndex(
          (ep) => ep.provider === s.provider && ep.modelId === s.modelId,
        )
        if (existingIdx >= 0) {
          // Same identity: update in place, preserve blank-key semantics via form key.
          const prevEp = next[existingIdx]!
          next[existingIdx] = {
            ...s,
            apiKey: s.apiKey.trim() ? s.apiKey : prevEp.apiKey,
            hasApiKey: s.apiKey.trim() ? true : prevEp.hasApiKey,
          }
        } else {
          next.push(s)
        }
      }
    }
    return persist(next)
  }

  async function removeEndpoint(idx: number) {
    const ep = endpoints[idx]!
    const referenced = defaults
      && (defaults.sessionModel?.provider === ep.provider && defaults.sessionModel.modelId === ep.modelId
        || defaults.reviewModelSet?.some(
          (m) => m.provider === ep.provider && m.modelId === ep.modelId,
        ))
    const msg = referenced
      ? `删除端点 ${ep.provider}/${ep.modelId}？\n该端点被 Agent 配置引用，删除后引用会被自动移除。`
      : `删除端点 ${ep.provider}/${ep.modelId}？`
    if (!window.confirm(msg)) return
    const next = endpoints.filter((_, j) => j !== idx)
    await persist(next)
  }

  /**
   * Persist the current endpoint list (+ optional defaults override) immediately.
   * PUT → reload from server so the UI always mirrors disk. Resolves true on success.
   */
  async function persist(
    nextEndpoints: LlmEndpointResponse[],
    nextDefaults?: LlmDefaultsResponse,
  ): Promise<boolean> {
    if (!loaded) {
      // Never let a truncated/invalid view overwrite the on-disk config.
      setError('配置加载失败，无法保存。请先刷新重试。')
      return false
    }
    setSaving(true)
    setError(null)
    try {
      await api.saveLlmEndpoints(nextEndpoints, sanitizeDefaults(nextDefaults ?? defaults, nextEndpoints))
      const res = await api.getLlmEndpoints()
      setEndpoints(res.endpoints)
      setDefaults(res.defaults)
      setSuccess('配置已保存')
      successTimer.current = setTimeout(() => setSuccess(null), SUCCESS_BANNER_MS)
      return true
    } catch (err) {
      setError(`保存失败: ${getErrorMessage(err)}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  /**
   * Purge default references that no longer match any configured endpoint.
   * If reviewModelSet drops below 2 after purge, return undefined so the server
   * clears defaults.
   */
  function sanitizeDefaults(
    d: LlmDefaultsResponse | undefined,
    eps: LlmEndpointResponse[],
  ): LlmDefaultsResponse | undefined {
    if (!d) return undefined
    const out: LlmDefaultsResponse = {}
    if (d.sessionModel) {
      const match = eps.find((e) => e.provider === d.sessionModel!.provider && e.modelId === d.sessionModel!.modelId)
      if (match) out.sessionModel = { ...d.sessionModel }
    }
    if (d.reviewModelSet) {
      const valid = d.reviewModelSet.filter((m) =>
        eps.some((e) => e.provider === m.provider && e.modelId === m.modelId)
      )
      if (valid.length >= 2) out.reviewModelSet = valid.map((m) => ({ ...m }))
    }
    if (!out.sessionModel && !out.reviewModelSet) return undefined
    return out
  }

  /** Unique provider+modelId endpoints for defaults pickers (no thinkingLevel duplicates). */
  const uniqueEndpoints = endpoints.filter(
    (ep, i, arr) => i === arr.findIndex(
      (e) => e.provider === ep.provider && e.modelId === ep.modelId
    )
  )

  /** Agent 配置变更 → 立即持久化（自动落盘，单管理员场景）。 */
  function handleDefaultsChange(next: LlmDefaultsResponse) {
    setDefaults(next)
    void persist(endpoints, next)
  }

  // Endpoint test state
  const [testingKey, setTestingKey] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ key: string; ok: boolean; message: string } | null>(null)

  /** Send a "你好" probe to a saved endpoint and record the outcome. */
  async function testEndpoint(ep: LlmEndpointResponse) {
    const key = `${ep.provider}/${ep.modelId}`
    setTestingKey(key)
    setTestResult(null)
    try {
      const res = await api.testLlmEndpoint(ep.provider, ep.modelId)
      if (res.ok && 'reply' in res) {
        setTestResult({
          key,
          ok: true,
          message: res.reply ? `可用：${res.reply}` : '可用',
        })
      } else {
        setTestResult({ key, ok: false, message: 'error' in res ? res.error : '测试失败' })
      }
    } catch (err) {
      setTestResult({ key, ok: false, message: getErrorMessage(err) })
    } finally {
      setTestingKey(null)
    }
  }

  return (
    <div className="page-enter space-y-6">
      {/* Back link */}
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
        <span aria-hidden="true">&larr;</span> 返回管理
      </Link>

      {/* Header */}
      <div className="flex items-center gap-3">
        <Cpu className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">LLM 配置</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            模型端点管理 · 端点 /models 主目录 · models.dev 仅补 limits
          </p>
        </div>
      </div>

      <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-brand-600 dark:text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">LLM 端点配置</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadConfig()}
            disabled={saving || loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-sm font-medium transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800/30 text-sm text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/30 text-sm text-emerald-700 dark:text-emerald-300">
          <Check className="h-4 w-4 shrink-0" />
          {success}
        </div>
      )}

      {/* Endpoint list */}
      {loading ? (
        <div className="text-sm text-slate-400 py-4 text-center">加载中...</div>
      ) : endpoints.length === 0 && !showForm ? (
        <div className="text-sm text-slate-400 py-4 text-center">
          尚未配置任何 LLM 端点
        </div>
      ) : (
        <div className="space-y-2">
          {endpoints.map((ep, i) => (
            <div
              key={`${ep.provider}/${ep.modelId}`}
              className="flex items-center gap-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 px-3 py-2"
            >
              <span className="text-xs font-mono font-medium text-slate-700 dark:text-slate-300 min-w-[80px]">
                {ep.provider}
              </span>
              <span className="text-xs font-mono text-slate-600 dark:text-slate-400 flex-1 truncate">
                {ep.modelId}
              </span>
              {ep.inputLimit && (
                <span className="text-xs font-mono text-slate-400 hidden sm:inline">
                  in:{(ep.inputLimit / 1000).toFixed(0)}K
                </span>
              )}
              {ep.maxOutputTokens && (
                <span className="text-xs font-mono text-slate-400 hidden sm:inline">
                  out:{(ep.maxOutputTokens / 1000).toFixed(0)}K
                </span>
              )}
              <button
                type="button"
                onClick={() => testEndpoint(ep)}
                disabled={testingKey !== null}
                className="text-xs text-slate-400 hover:text-brand-500 transition-colors disabled:opacity-50"
              >
                {testingKey === `${ep.provider}/${ep.modelId}` ? '测试中...' : '测试'}
              </button>
              {testResult?.key === `${ep.provider}/${ep.modelId}` && (
                <span
                  className={`text-xs max-w-[260px] truncate ${testResult.ok
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400'
                  }`}
                  title={testResult.message}
                >
                  {testResult.ok ? '✓' : '✗'} {testResult.message}
                </span>
              )}
              <button
                type="button"
                onClick={() => openEditForm(i)}
                className="text-xs text-slate-400 hover:text-brand-500 transition-colors"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => removeEndpoint(i)}
                className="text-slate-400 hover:text-rose-500 transition-colors"
                aria-label={`删除 ${ep.modelId}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Add button */}
      {!showForm && (
        <button
          type="button"
          onClick={openAddForm}
          className="inline-flex items-center gap-1.5 text-xs text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          添加模型
        </button>
      )}

      {/* Add/Edit form — extracted to AdminLlmForm */}
      {showForm && (
        <AdminLlmForm
          endpoint={form}
          isNew={editIndex === null}
          modelsDevIndex={modelsDevIndex ?? []}
          onSave={handleFormSave}
          onCancel={closeForm}
        />
      )}
    </div>
      {/* Agent 配置 — extracted to AgentDefaultsSection */}
      <AgentDefaultsSection
        defaults={defaults}
        uniqueEndpoints={uniqueEndpoints}
        saving={saving}
        onChange={handleDefaultsChange}
      />
    </div>
  )
}
