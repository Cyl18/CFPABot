import { useState, useEffect } from 'react'
import { Zap, Plus, X } from 'lucide-react'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/helpers'

const MOCKABLE_METHODS = [
  'getPullRequest',
  'getPullRequestFiles',
  'getPullRequestDiff',
  'getPrComments',
  'createIssueComment',
  'checkCollaborator',
  'getRateLimit',
  'getWorkflowRun',
  'searchPulls',
  'getBotComments',
  'findBotComment',
  'findPrFromHeadRef',
  'getArtifactsFromWorkflow',
]

export default function AdminMockConfig() {
  const [overrideMethod, setOverrideMethod] = useState('getPullRequest')
  const [overrideJson, setOverrideJson] = useState('{\n  "number": 1234,\n  "state": "open"\n}')
  const [overrides, setOverrides] = useState<Record<string, unknown>>({})
  const [addingOverride, setAddingOverride] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getMockConfig().then((cfg) => setOverrides(cfg.overrides)).catch(() => {})
  }, [])

  async function handleAddOverride() {
    setAddingOverride(true)
    // 先独立解析 JSON:解析失败与请求失败分开提示
    let parsed: unknown
    try {
      parsed = JSON.parse(overrideJson)
    } catch {
      setError('JSON 格式错误:请检查输入是否为合法 JSON')
      setAddingOverride(false)
      return
    }
    try {
      const cfg = await api.setMockOverride(overrideMethod, parsed)
      setOverrides(cfg.overrides)
    } catch (err) {
      setError(`设置失败: ${getErrorMessage(err)}`)
    } finally {
      setAddingOverride(false)
    }
  }

  async function handleRemoveOverride(method: string) {
    try {
      const cfg = await api.clearMockOverride(method)
      setOverrides(cfg.overrides)
    } catch (err) {
      setError(`删除失败: ${getErrorMessage(err)}`)
    }
  }

  async function handleClearOverrides() {
    try {
      const cfg = await api.clearAllMockOverrides()
      setOverrides(cfg.overrides)
    } catch (err) {
      setError(`清空失败: ${getErrorMessage(err)}`)
    }
  }

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Mock 返回值配置</h2>
        </div>
        {Object.keys(overrides).length > 0 && (
          <button
            type="button"
            onClick={handleClearOverrides}
            aria-label="清除全部覆盖"
            className="text-xs text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
          >
            清除全部
          </button>
        )}
      </div>

      {/* Add override form */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <select
          value={overrideMethod}
          onChange={(e) => setOverrideMethod(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {MOCKABLE_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAddOverride}
          disabled={addingOverride}
          aria-label="添加覆盖"
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
      <textarea
        value={overrideJson}
        onChange={(e) => setOverrideJson(e.target.value)}
        placeholder='{"number": 1234, "state": "open"}'
        rows={4}
        className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y"
      />
      {error && (
        <div className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</div>
      )}

      {/* Active overrides list */}
      {Object.keys(overrides).length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">当前覆盖项</p>
          <div className="space-y-1.5">
            {Object.entries(overrides).map(([method, result]) => (
              <div
                key={method}
                className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 px-3 py-2"
              >
                <span className="text-xs font-mono font-medium text-slate-700 dark:text-slate-300 flex-1 truncate">
                  {method}
                </span>
                <pre className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate max-w-[200px]">
                  {JSON.stringify(result)}
                </pre>
                <button
                  type="button"
                  onClick={() => handleRemoveOverride(method)}
                  aria-label={`删除覆盖 ${method}`}
                  className="text-slate-400 hover:text-rose-500 transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
