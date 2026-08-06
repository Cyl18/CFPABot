import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import type { OutboundCall } from '@/lib/api'
import { fmtTime, tryFormatJson } from './helpers'

export default function OutboundCallRow({ call }: { call: OutboundCall }) {
  const [expanded, setExpanded] = useState(false)
  const hasError = call.result && typeof call.result === 'object' && '__mockError' in (call.result as Record<string, unknown>)

  return (
    <div className="border-b border-slate-200 dark:border-slate-700/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={expanded ? '折叠调用详情' : '展开调用详情'}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        )}
        <span className="text-xs text-slate-400 font-mono w-8 shrink-0">#{call.id}</span>
        <span className="text-xs text-slate-400 font-mono w-20 shrink-0">{fmtTime(call.timestamp)}</span>
        <span
          className={`text-sm font-mono font-medium ${
            hasError ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'
          }`}
        >
          {call.method}
        </span>
        {hasError ? (
          <span className="ml-auto flex items-center gap-1 text-xs text-rose-500">
            <AlertTriangle className="h-3 w-3" />
            Error
          </span>
        ) : null}
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-1 font-medium">Arguments</p>
            <pre className="text-xs font-mono bg-slate-50 dark:bg-slate-900 rounded p-2.5 text-slate-600 dark:text-slate-400 overflow-x-auto max-h-32">
              {tryFormatJson(call.args)}
            </pre>
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-1 font-medium">Result</p>
            <pre
              className={`text-xs font-mono rounded p-2.5 overflow-x-auto max-h-48 ${
                hasError
                  ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300'
                  : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400'
              }`}
            >
              {tryFormatJson(call.result)}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
