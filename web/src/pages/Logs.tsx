import { Link } from "react-router-dom"

import { useState, useEffect, useCallback, useRef } from 'react'
import { ScrollText, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { api, type LogEntry } from '@/lib/api'

const LEVEL_FILTERS = [
  { key: '', label: '全部' },
  { key: 'error', label: 'Error' },
  { key: 'warn', label: 'Warn' },
  { key: 'info', label: 'Info' },
  { key: 'debug', label: 'Debug' },
] as const

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-blue-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  debug: 'text-purple-400',
}

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set())
  /** 请求序号:过滤快速切换时只接受最新请求的响应 */
  const loadReqId = useRef(0)

  const toggleExpand = useCallback((idx: number) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getLogs(filter || undefined, 500)
      setLogs(data)
      setExpandedIndices(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  return (
    <div className="page-enter space-y-6">
      {/* Back link */}
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
        <span aria-hidden="true">&larr;</span> 返回管理
      </Link>

      <div className="flex items-center gap-3">
        <ScrollText className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">事件日志</h1>
      </div>

      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            {LEVEL_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`chip${filter === key ? ' active' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button onClick={fetchLogs} className="btn btn-ghost btn-sm" disabled={loading}>
            <RefreshCw className={`h-3 w-3${loading ? ' animate-spin' : ''}`} />
            刷新
          </button>
          </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && logs.length === 0 ? (
        <div className="bg-slate-900 dark:bg-slate-950 rounded-lg p-4 font-mono text-xs text-slate-300 max-h-[500px] overflow-y-auto">
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          </div>
        </div>
      ) : (
        <div className="bg-slate-900 dark:bg-slate-950 rounded-lg p-4 font-mono text-xs text-slate-300 max-h-[500px] overflow-y-auto space-y-1">
          {logs.length === 0 && (
            <div className="text-slate-500 text-center py-8">暂无日志</div>
          )}
          {logs.map((entry, i) => {
            const hasData = entry.data && typeof entry.data === 'object' && Object.keys(entry.data).length > 0
            const isExpanded = expandedIndices.has(i)
            return (
              <div key={entry.timestamp + '-' + i}>
                <span className="text-emerald-400">[{entry.timestamp}]</span>{' '}
                <span className={LEVEL_COLORS[entry.level] ?? 'text-slate-400'}>
                  [{entry.level.toUpperCase().padEnd(5)}]
                </span>{' '}
                {entry.message}
                {hasData && (
                  <button
                    onClick={() => toggleExpand(i)}
                    className="ml-2 inline-flex items-center gap-0.5 text-slate-500 hover:text-slate-300 transition-colors"
                    title={isExpanded ? '收起数据' : '展开数据'}
                  >
                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <span className="text-[10px]">DATA</span>
                  </button>
                )}
                {isExpanded && hasData && (
                  <pre className="mt-1 ml-4 rounded bg-slate-950 p-2 text-[11px] text-slate-400 overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(entry.data, null, 2)}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
    </div>
  )
}
