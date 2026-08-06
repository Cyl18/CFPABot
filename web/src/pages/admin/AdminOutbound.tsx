import { useEffect, useState, useCallback, useRef } from 'react'
import { Trash2, RotateCcw, Terminal, Clock } from 'lucide-react'
import { api, type OutboundCall } from '@/lib/api'
import { getErrorMessage } from '@/lib/helpers'
import OutboundCallRow from './OutboundCallRow'

export default function AdminOutbound() {
  const [calls, setCalls] = useState<OutboundCall[]>([])
  const [mockActive, setMockActive] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refreshTimer = useRef<number | undefined>(undefined)
  /** in-flight 标记:慢请求未返回时跳过本轮轮询,避免请求叠加 */
  const inFlightRef = useRef(false)

  const fetchCalls = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const data = await api.getOutboundCalls()
      setCalls(data.calls)
      setMockActive(data.active)
    } catch {
      // Silently ignore — dev panel only works in dev mode
    } finally {
      inFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    fetchCalls()
  }, [fetchCalls])

  // Auto-refresh interval
  useEffect(() => {
    if (autoRefresh) {
      refreshTimer.current = setInterval(fetchCalls, 2000)
      return () => clearInterval(refreshTimer.current)
    }
    return undefined
  }, [autoRefresh, fetchCalls])

  async function handleClearCalls() {
    try {
      await api.clearOutboundCalls()
      fetchCalls()
    } catch (err) {
      setError(`清空失败: ${getErrorMessage(err)}`)
    }
  }

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Outbound 调用日志
          </h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">({calls.length})</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Auto-refresh toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-xs text-slate-500 dark:text-slate-400">自动刷新</span>
          </label>
          <button
            type="button"
            onClick={fetchCalls}
            aria-label="刷新调用日志"
            className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
            刷新
          </button>
          <button
            type="button"
            onClick={handleClearCalls}
            disabled={calls.length === 0}
            aria-label="清空调用日志"
            className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 className="h-3 w-3" />
            清空
          </button>
        </div>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            mockActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-600'
          }`}
        />
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {mockActive ? 'Mock 模式活跃 — 调用被拦截' : 'Mock 模式未活跃 — 等待 webhook 触发'}
        </span>
      </div>

      {error && (
        <div className="mb-3 text-xs text-red-500 dark:text-red-400">{error}</div>
      )}

      {/* Call list */}
      {calls.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
          <Clock className="h-8 w-8 mb-2" />
          <p className="text-sm">暂无 outbound 调用</p>
          <p className="text-xs mt-1">触发 mock webhook 后，这里会显示所有 GitHub API 调用</p>
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-700/50 rounded-lg overflow-hidden max-h-[600px] overflow-y-auto">
          {calls.map((call) => (
            <OutboundCallRow key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  )
}
