import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, CheckCircle2, AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/helpers'

const FALLBACK_EVENT_TYPES = [
  { value: 'pull_request.opened', label: 'PR 开启' },
  { value: 'pull_request.synchronize', label: 'PR 同步' },
  { value: 'pull_request.labeled', label: 'PR 加标签' },
  { value: 'pull_request.unlabeled', label: 'PR 移除标签' },
  { value: 'issue_comment.created', label: '评论创建' },
]

const EVENT_TYPE_LABELS: Record<string, string> = {
  'pull_request.opened': 'PR 开启',
  'pull_request.synchronize': 'PR 同步',
  'pull_request.labeled': 'PR 加标签',
  'pull_request.unlabeled': 'PR 移除标签',
  'pull_request.edited': 'PR 编辑',
  'pull_request.closed': 'PR 关闭',
  'issue_comment.created': '评论创建',
  'issue_comment.edited': '评论编辑',
  'workflow_run': '工作流运行',
}

function buildEventTypes(eventTypes: string[]): { value: string; label: string }[] {
  return eventTypes.map((et) => ({
    value: et,
    label: EVENT_TYPE_LABELS[et] ?? et,
  }))
}

export default function AdminWebhook() {
  const navigate = useNavigate()
  const [eventTypes, setEventTypes] = useState(FALLBACK_EVENT_TYPES)
  const [eventTypesLoading, setEventTypesLoading] = useState(true)
  const [eventType, setEventType] = useState('pull_request.opened')
  const [prId, setPrId] = useState('')
  const [payloadJson, setPayloadJson] = useState('')
  const [triggering, setTriggering] = useState(false)
  const [triggerResult, setTriggerResult] = useState<{ ok: boolean; message: string; tip?: string } | null>(null)

  // Load event types from dev API (soft-fall back to FALLBACK_EVENT_TYPES)
  useEffect(() => {
    let cancelled = false
    api.getEventTypes()
      .then((res) => {
        if (!cancelled) {
          setEventTypes(buildEventTypes(res.eventTypes))
          // Reset selection if current value not in new list
          if (res.eventTypes.length > 0 && !res.eventTypes.includes(eventType)) {
            setEventType(res.eventTypes[0])
          }
        }
      })
      .catch(() => {
        // Keep fallback — dev-only endpoint may 403 outside Development
      })
      .finally(() => {
        if (!cancelled) setEventTypesLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  async function handleTrigger() {
    setTriggering(true)
    setTriggerResult(null)
    try {
      const result = await api.mockWebhook(
        eventType,
        Number(prId),
        payloadJson.trim() ? JSON.parse(payloadJson) : undefined,
      )
      setTriggerResult({ ok: true, message: result.message, tip: result.tip })
    } catch (err) {
      setTriggerResult({ ok: false, message: getErrorMessage(err) })
    } finally {
      setTriggering(false)
    }
  }

  return (
    <div className="card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Play className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Mock Webhook 触发</h2>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
            事件类型
          </label>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {eventTypes.map((et) => (
              <option key={et.value} value={et.value}>
                {et.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
            PR 编号
          </label>
          <input
            type="number"
            value={prId}
            onChange={(e) => setPrId(e.target.value)}
            placeholder="例如: 1234"
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
            自定义 Payload (可选 JSON)
          </label>
          <textarea
            value={payloadJson}
            onChange={(e) => setPayloadJson(e.target.value)}
            placeholder={'{\n  "pull_request": {\n    "number": 1234\n  }\n}'}
            rows={5}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y"
          />
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
            留空使用构造的最小 payload。填写后<b>整体替换</b>默认 payload，需自行补全所需字段（sender / base / head 等）。
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleTrigger}
            disabled={triggering || !prId}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            <Play className="h-4 w-4" />
            {triggering ? '触发中...' : '触发 Mock Webhook'}
          </button>

          {triggerResult?.ok && (
            <button
              type="button"
              onClick={() => navigate(`/pr/${prId}`)}
              aria-label="查看 PR"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              查看 PR
            </button>
          )}
        </div>

        {triggerResult && (
          <div
            className={`flex items-start gap-2 rounded-lg p-3 text-sm ${
              triggerResult.ok
                ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300'
                : 'bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-300'
            }`}
          >
            {triggerResult.ok ? (
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <div>
              <p>{triggerResult.message}</p>
              {triggerResult.tip && <p className="text-xs mt-1 opacity-80">{triggerResult.tip}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
