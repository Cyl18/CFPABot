// Agent 配置区 (defaults: session model + MoA review model set) — extracted
// from AdminLlmConfig. Owns the review-pool picker state; every mutation is
// reported up via onChange, where the parent persists immediately (auto-save).

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { LlmDefaultsResponse, LlmEndpointResponse, ThinkingLevel } from '@/lib/api'
import { formatModelRef, parseModelRef } from '@/lib/llm-models'

const THINKING_LEVEL_OPTIONS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: 'off' },
  { value: 'minimal', label: 'min' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'med' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]

function ThinkingLevelSelect({
  value,
  disabled,
  onChange,
  className,
}: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
    >
      <option value="">默认</option>
      {THINKING_LEVEL_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export interface AgentDefaultsSectionProps {
  defaults: LlmDefaultsResponse | undefined
  /** Unique provider+modelId endpoints — the pool both pickers read from. */
  uniqueEndpoints: LlmEndpointResponse[]
  saving: boolean
  /** Report a new defaults value; the parent persists it immediately. */
  onChange: (next: LlmDefaultsResponse) => void
}

export default function AgentDefaultsSection({
  defaults,
  uniqueEndpoints,
  saving,
  onChange,
}: AgentDefaultsSectionProps) {
  const [reviewPoolPick, setReviewPoolPick] = useState('')

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Agent 配置</h2>
      </div>
      <p className="text-[11px] text-slate-400">
        新建会话和无 modelSetId 的审查任务会使用以下默认模型与思考强度。
      </p>

      {/* Default session model — single select + thinkingLevel */}
      <div>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
          主模型
        </label>
        <div className="flex gap-2">
          <select
            value={formatModelRef(defaults?.sessionModel)}
            onChange={(e) => {
              const ref = parseModelRef(e.target.value)
              const next: LlmDefaultsResponse = {
                ...(defaults ?? {}),
                ...(ref ? { sessionModel: { provider: ref.provider, modelId: ref.modelId } } : { sessionModel: undefined }),
              }
              onChange(next)
            }}
            disabled={uniqueEndpoints.length === 0 || saving}
            className="flex-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
          >
            <option value="">- 自动选择第一个端点 -</option>
            {uniqueEndpoints.map((ep) => (
              <option key={`${ep.provider}/${ep.modelId}`} value={formatModelRef({ provider: ep.provider, modelId: ep.modelId })}>
                {ep.provider}/{ep.modelId}
              </option>
            ))}
          </select>
          <ThinkingLevelSelect
            value={defaults?.sessionModel?.thinkingLevel ?? ''}
            disabled={!defaults?.sessionModel || saving}
            onChange={(val) => {
              const next: LlmDefaultsResponse = {
                ...(defaults ?? {}),
                sessionModel: defaults?.sessionModel
                  ? { ...defaults.sessionModel, thinkingLevel: val as ThinkingLevel | undefined }
                  : defaults?.sessionModel,
              }
              onChange(next)
            }}
            className="w-[110px] rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
          />
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          思考强度：主模型的推理级别，留空使用 SDK 默认。
        </p>
      </div>

      {/* Review model set — add from pool with per-model thinkingLevel */}
      <div>
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
          审查模型集（MoA，至少2个）
        </label>
        {uniqueEndpoints.length === 0 ? (
          <p className="text-[11px] text-slate-400">请先添加至少两个 LLM 端点</p>
        ) : (
          <>
            {/* Pool picker + add button */}
            <div className="flex gap-2">
              <select
                value={reviewPoolPick}
                onChange={(e) => setReviewPoolPick(e.target.value)}
                disabled={uniqueEndpoints.length === 0}
                className="flex-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
              >
                <option value="" disabled>选择模型</option>
                {uniqueEndpoints.map((ep) => (
                  <option key={`${ep.provider}/${ep.modelId}`} value={formatModelRef({ provider: ep.provider, modelId: ep.modelId })}>
                    {ep.provider}/{ep.modelId}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const ref = parseModelRef(reviewPoolPick)
                  if (!ref) return
                  onChange({
                    ...(defaults ?? {}),
                    reviewModelSet: [...(defaults?.reviewModelSet ?? []), { provider: ref.provider, modelId: ref.modelId }],
                  })
                  setReviewPoolPick('')
                }}
                disabled={!reviewPoolPick || saving}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                添加
              </button>
            </div>

            {/* Added models list */}
            {(defaults?.reviewModelSet?.length ?? 0) > 0 && (
              <div className="mt-2 space-y-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2">
                {defaults!.reviewModelSet!.map((m, i) => (
                  <div key={`${m.provider}/${m.modelId}`} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <span className="text-xs font-mono text-slate-700 dark:text-slate-300 flex-1 truncate">
                      {m.provider}/{m.modelId}
                    </span>
                    <ThinkingLevelSelect
                      value={m.thinkingLevel ?? ''}
                      onChange={(val) => {
                        const next = [...defaults!.reviewModelSet!]
                        next[i] = { ...next[i]!, thinkingLevel: val as ThinkingLevel | undefined }
                        onChange({ ...(defaults ?? {}), reviewModelSet: next })
                      }}
                      disabled={saving}
                      className="w-[90px] rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-600 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = defaults!.reviewModelSet!.filter((_, j) => j !== i)
                        onChange({
                          ...(defaults ?? {}),
                          reviewModelSet: next.length > 0 ? next : undefined,
                        })
                      }}
                      disabled={saving}
                      className="text-slate-400 hover:text-rose-500 transition-colors"
                      aria-label={`移除 ${m.provider}/${m.modelId}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Status messages */}
            {defaults?.reviewModelSet && defaults.reviewModelSet.length > 0 && defaults.reviewModelSet.length < 2 && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                审查模型集至少需要 2 个模型
              </p>
            )}
            {defaults?.reviewModelSet && defaults.reviewModelSet.length >= 2 && (
              <p className="mt-1 text-[10px] text-slate-400">
                已添加 {defaults.reviewModelSet.length} 个模型
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
