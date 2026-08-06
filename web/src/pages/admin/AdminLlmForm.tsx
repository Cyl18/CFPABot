import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { LlmEndpointResponse } from '@/lib/api'
import {
  pickModelLimits,
  PROVIDER_PRESETS,
  DEFAULT_BASE_URLS,
  DEFAULT_PROTOCOLS,
  KNOWN_PROTOCOLS,
  normalizeLlmBaseUrl,
  inferProtocolFromUrl,
  type FlatModelEntry,
} from '@/lib/llm-models'
import LiveModelsPicker from './LiveModelsPicker'

export interface AdminLlmFormProps {
  endpoint: LlmEndpointResponse
  isNew: boolean
  modelsDevIndex: FlatModelEntry[]
  /** Persist one or more endpoints (add mode batches all selected models in one call). Resolves true when the write succeeded. */
  onSave: (saved: LlmEndpointResponse[]) => Promise<boolean>
  onCancel: () => void
}

export default function AdminLlmForm({ endpoint, isNew, modelsDevIndex, onSave, onCancel }: AdminLlmFormProps) {
  const [form, setForm] = useState<LlmEndpointResponse>({ ...endpoint })

  /** Add-mode multi-select of model ids (shared provider/protocol/baseUrl/apiKey). */
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([])

  /** Silently fill input/output limits from models.dev when a model id is known. */
  function enrichLimitsForModelId(modelId: string) {
    const limits = pickModelLimits(modelsDevIndex, modelId)
    if (!limits) return
    setForm((prev) => ({
      ...prev,
      inputLimit: limits.inputLimit ?? prev.inputLimit,
      maxOutputTokens: limits.maxOutputTokens ?? prev.maxOutputTokens,
    }))
  }

  function handleModelInput(value: string) {
    setForm((prev) => ({ ...prev, modelId: value }))
  }

  /** Edit mode: pick one live model into the form. Add mode: toggle multi-select. */
  function selectLiveModel(modelId: string, mode: 'toggle' | 'pick') {
    if (mode === 'toggle') {
      setSelectedModelIds((prev) =>
        prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId],
      )
    } else {
      setForm((prev) => ({ ...prev, modelId }))
    }
    // Best-effort silent limits for the touched id (form limits = fallback for batch).
    enrichLimitsForModelId(modelId)
  }

  /** Add-mode helper: push the typed Model ID into the multi-select set. */
  function addTypedModelId() {
    const id = form.modelId.trim()
    if (!id) return
    setSelectedModelIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setForm((prev) => ({ ...prev, modelId: '' }))
    enrichLimitsForModelId(id)
  }

  function removeSelectedModelId(modelId: string) {
    setSelectedModelIds((prev) => prev.filter((id) => id !== modelId))
  }

  /** Model ids that will be written on submit (add mode prefers multi-select). */
  const pendingModelIds: string[] =
    !isNew
      ? (form.modelId.trim() ? [form.modelId.trim()] : [])
      : (() => {
          const ids = [...selectedModelIds]
          const typed = form.modelId.trim()
          if (typed && !ids.includes(typed)) ids.push(typed)
          return ids
        })()

  /** Auto-fill protocol and baseUrl defaults when provider changes. */
  function handleProviderChange(provider: string) {
    const defaults = {
      protocol: DEFAULT_PROTOCOLS[provider],
      baseUrl: DEFAULT_BASE_URLS[provider] ?? '',
    }
    setForm((prev) => ({ ...prev, provider, ...defaults }))
  }

  function handleFormChange(field: keyof LlmEndpointResponse, value: string | number | undefined) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  /** On Base URL blur: normalize to API root + auto-guess protocol from path hints. */
  function handleBaseUrlBlur() {
    const raw = form.baseUrl
    const root = normalizeLlmBaseUrl(raw)
    const inferred = inferProtocolFromUrl(raw)
    setForm((prev) => ({
      ...prev,
      baseUrl: root,
      ...(inferred !== undefined ? { protocol: inferred } : {}),
    }))
  }

  /** 编辑模式下身份(provider/modelId)变更 → 旧密钥不再属于该身份,必须重输 */
  const identityChanged = !isNew && (endpoint.provider !== form.provider || endpoint.modelId !== form.modelId)

  async function handleSubmit() {
    if (!isNew) {
      if (!form.modelId.trim()) return
      const ok = await onSave([{
        ...form,
        // 身份变更时丢弃旧密钥引用,提交新输入的 key(后端对不匹配身份拒绝空 key)
        ...(identityChanged ? { apiKey: form.apiKey.trim(), hasApiKey: form.apiKey.trim().length > 0 } : {}),
      }])
      if (ok) onCancel()
      return
    }

    // Add mode: one or many models sharing provider/protocol/baseUrl/apiKey.
    const modelIds = pendingModelIds
    if (modelIds.length === 0) return
    if (!form.provider.trim()) return
    if (!/^https?:\/\/.+/.test(form.baseUrl)) return

    const saved: LlmEndpointResponse[] = modelIds.map((modelId) => {
      const limits = modelsDevIndex ? pickModelLimits(modelsDevIndex, modelId) : undefined
      return {
        provider: form.provider.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        hasApiKey: form.hasApiKey || form.apiKey.trim().length > 0,
        modelId,
        // Prefer per-model models.dev limits; fall back to form values for manual batch.
        inputLimit: limits?.inputLimit ?? form.inputLimit,
        maxOutputTokens: limits?.maxOutputTokens ?? form.maxOutputTokens,
      }
    })
    const ok = await onSave(saved)
    if (ok) onCancel()
  }

  const formValid =
    (form.apiKey.trim() || form.hasApiKey)
    && (!identityChanged || form.apiKey.trim().length > 0)
    && pendingModelIds.length > 0
    && (!isNew || (form.provider.trim().length > 0 && /^https?:\/\/.+/.test(form.baseUrl)))

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-3">
      <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
        {!isNew ? '编辑端点' : '添加端点'}
      </h3>

      {/* Provider — preset select + custom free text */}
      <div>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
          Provider
        </label>
        <select
          value={PROVIDER_PRESETS.some((p) => p.slug === form.provider) ? form.provider : ''}
          onChange={(e) => {
            if (e.target.value) handleProviderChange(e.target.value)
          }}
          className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="" disabled>选择 provider（可手填自定义）</option>
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.slug} value={p.slug}>{p.label}</option>
          ))}
        </select>
        <input
          type="text"
          value={form.provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          placeholder="自定义 provider 标识，如 siliconflow、vllm"
          className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          选择预设会自动填写 Base URL 与 Protocol，均可修改
        </p>
      </div>
      {/* Protocol */}
      <div>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
          Protocol <span className="text-slate-400 font-normal">(自动填写，可修改)</span>
        </label>
        <select
          value={form.protocol ?? ''}
          onChange={(e) => handleFormChange('protocol', e.target.value || undefined)}
          className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">选择协议（可手选，也可由 Base URL 自动推断）</option>
          {KNOWN_PROTOCOLS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      {/* Base URL */}
      <div>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
          Base URL
        </label>
        <input
          type="text"
          value={form.baseUrl}
          onChange={(e) => handleFormChange('baseUrl', e.target.value)}
          onBlur={handleBaseUrlBlur}
          placeholder="https://api.openai.com/v1"
          className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          可粘贴带 /chat/completions 的完整地址，会自动规范为 API 根路径
        </p>
      </div>

      <div>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
          API Key
        </label>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => handleFormChange('apiKey', e.target.value)}
          placeholder={identityChanged ? '身份已变更,必须输入新 API Key' : !isNew && form.hasApiKey ? '留空保留原值' : 'sk-...'}
          className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {identityChanged && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            Provider / Model ID 已变更,需重新输入 API Key 才能保存
          </p>
        )}
      </div>

      {/* Live endpoint /models pull — extracted to LiveModelsPicker */}
      <LiveModelsPicker
        baseUrl={form.baseUrl}
        apiKey={form.apiKey}
        hasApiKey={form.hasApiKey}
        protocol={form.protocol}
        provider={form.provider}
        modelId={form.modelId}
        isNew={isNew}
        selectedModelIds={selectedModelIds}
        onToggleModel={(id) => selectLiveModel(id, 'toggle')}
        onPickModel={(id) => selectLiveModel(id, 'pick')}
      />

      {/* Model ID — manual only. Catalog lives in "拉取端点模型"; models.dev only fills limits. */}
      <div>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
          Model ID
          <span className="ml-1 font-normal text-slate-400">
            {isNew ? '（手填或从上方列表勾选）' : '（手填或从上方列表点选）'}
          </span>
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={form.modelId}
            onChange={(e) => handleModelInput(e.target.value)}
            onBlur={() => {
              const id = form.modelId.trim()
              if (id) enrichLimitsForModelId(id)
            }}
            placeholder={isNew ? '手填模型名，或点「加入列表」' : '如 DeepSeek-V3.2'}
            className="flex-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {isNew && (
            <button
              type="button"
              onClick={addTypedModelId}
              disabled={!form.modelId.trim()}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-3.5 w-3.5" />
              加入列表
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          主目录来自「拉取端点模型」；此处仅手填。models.dev 只在后台补 token 上限，不参与搜索。
        </p>
        {isNew && selectedModelIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedModelIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-800 px-2 py-0.5 text-[11px] font-mono"
              >
                {id}
                <button
                  type="button"
                  onClick={() => removeSelectedModelId(id)}
                  className="text-brand-500 hover:text-rose-500"
                  aria-label={`移除 ${id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

      </div>


      {/* Input limit + Output limit */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
            Input Limit (tokens)
          </label>
          <input
            type="number"
            value={form.inputLimit ?? ''}
            onChange={(e) => handleFormChange('inputLimit', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="128000"
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
            Max Output (tokens)
          </label>
          <input
            type="number"
            value={form.maxOutputTokens ?? ''}
            onChange={(e) => handleFormChange('maxOutputTokens', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="16384"
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>


      {/* Form actions */}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!formValid}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {!isNew
            ? '更新'
            : pendingModelIds.length > 1
              ? `添加 ${pendingModelIds.length} 个模型`
              : '添加'}
        </button>
      </div>
    </div>
  )
}
