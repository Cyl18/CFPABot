// Live endpoint /models puller — extracted from AdminLlmForm.
// Owns the pull state (models list, loading, error, filter, visibility) and
// renders the list UI. Selection semantics stay with the parent: it calls
// onToggleModel (add mode multi-select) or onPickModel (edit mode single-select),
// and the parent enriches models.dev limits on each pick.

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, type LlmProtocol } from '@/lib/api'
import { getErrorMessage } from '@/lib/helpers'

export interface LiveModelsPickerProps {
  baseUrl: string
  apiKey: string
  /** Edit mode: a stored key exists on the server (never echoed to the client). */
  hasApiKey: boolean
  protocol?: LlmProtocol
  /** Identity used by the ref-mode probe (stored-key fallback) when no key was typed. */
  provider: string
  modelId: string
  isNew: boolean
  /** Add-mode multi-select set, owned by the parent form. */
  selectedModelIds: string[]
  onToggleModel: (modelId: string) => void
  onPickModel: (modelId: string) => void
}

export default function LiveModelsPicker({
  baseUrl,
  apiKey,
  hasApiKey,
  protocol,
  provider,
  modelId,
  isNew,
  selectedModelIds,
  onToggleModel,
  onPickModel,
}: LiveModelsPickerProps) {
  const [liveModels, setLiveModels] = useState<string[]>([])
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [showLiveList, setShowLiveList] = useState(false)
  const [liveFilter, setLiveFilter] = useState('')

  /** Add mode needs a real key typed this session; edit mode can fall back to the stored key. */
  const liveButtonEnabled = /^https?:\/\/.+/.test(baseUrl)
    && (isNew ? apiKey.trim().length > 0 : apiKey.trim().length > 0 || hasApiKey)

  /** Goes through the backend proxy to dodge CORS. */
  async function handlePullLiveModels() {
    setLiveLoading(true)
    setLiveError(null)
    try {
      // Edit mode with a saved key: let the backend fall back to the stored key
      // (never echoed to the client) unless a new key was typed this session.
      const res = apiKey.trim()
        ? await api.probeLlmModels(baseUrl, apiKey.trim(), protocol)
        : await api.probeLlmModelsRef(provider, modelId, baseUrl, protocol)
      if ('error' in res) {
        const detail = res.detail ? `：${res.detail}` : ''
        throw new Error(`${res.error}${detail}`)
      }
      const ids = res.models
      setLiveModels(ids)
      setShowLiveList(ids.length > 0)
      setLiveFilter('')
    } catch (err) {
      const raw = getErrorMessage(err)
      let friendly: string
      if (/parse JSON|Unexpected token|JSON\.parse/i.test(raw)) {
        friendly = '服务端返回了无法解析的响应'
      } else if (/无法连接端点|Failed to fetch|TypeError|fetch|网络/i.test(raw)) {
        friendly = '无法访问端点（网络或上游问题）'
      } else {
        friendly = raw
      }
      setLiveError(`${friendly} — 可手动填写 Model ID`)
      setLiveModels([])
      setShowLiveList(false)
    } finally {
      setLiveLoading(false)
    }
  }

  const filteredLiveModels = liveModels.filter((m) =>
    m.toLowerCase().includes(liveFilter.toLowerCase()),
  )

  return (
    <div>
      <button
        type="button"
        onClick={handlePullLiveModels}
        disabled={!liveButtonEnabled || liveLoading}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${liveLoading ? 'animate-spin' : ''}`} />
        拉取端点模型
      </button>
      {!liveButtonEnabled && !isNew && hasApiKey && apiKey.trim() === '' && (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          编辑模式使用已保存的密钥拉取；需先填写有效的 Base URL
        </p>
      )}
      {liveError && (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {liveError}
        </p>
      )}
      {showLiveList && filteredLiveModels.length > 0 && (
        <div className="mt-2">
          <input
            type="text"
            value={liveFilter}
            onChange={(e) => setLiveFilter(e.target.value)}
            placeholder="从已拉取列表中筛选模型（支持完整关键词）..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-[10px] text-slate-400">
            端点 /models · 共 {liveModels.length} 个，显示 {Math.min(filteredLiveModels.length, 20)} 个（筛出 {filteredLiveModels.length} 个）
            {isNew ? ' · 添加模式可多选，共享同一密钥' : ' · 编辑模式单选'}
          </p>
          <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 divide-y divide-slate-100 dark:divide-slate-700/50">
            {filteredLiveModels.slice(0, 20).map((id) => {
              const selected = selectedModelIds.includes(id)
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => (isNew ? onToggleModel(id) : onPickModel(id))}
                    className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors truncate flex items-center gap-2 ${
                      selected
                        ? 'bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-brand-50 dark:hover:bg-brand-950/20'
                    }`}
                  >
                    {isNew && (
                      <span
                        aria-hidden="true"
                        className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                          selected
                            ? 'border-brand-500 bg-brand-500 text-white'
                            : 'border-slate-300 dark:border-slate-600'
                        }`}
                      >
                        {selected ? '✓' : ''}
                      </span>
                    )}
                    <span className="truncate">{id}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {filteredLiveModels.length > 20 && (
            <p className="mt-1 text-[10px] text-slate-400">
              还有 {filteredLiveModels.length - 20} 个模型未显示，请在筛选框中继续输入
            </p>
          )}
        </div>
      )}
      {showLiveList && filteredLiveModels.length === 0 && liveModels.length > 0 && (
        <p className="mt-1 text-[11px] text-slate-400">没有匹配筛选的模型</p>
      )}
    </div>
  )
}
