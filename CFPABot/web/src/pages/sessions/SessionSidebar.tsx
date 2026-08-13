// web/src/pages/sessions/SessionSidebar.tsx
// Left sidebar showing session list, new session button, session status badges.

import { Plus, Square, Archive } from 'lucide-react'
import type { AgentSession } from '@/lib/api'
import { useNavigate } from 'react-router-dom'
import { SessionStatusBadge } from '@/pages/sessions/components'
import { relativeTime, truncateId } from '@/pages/sessions/helpers'

interface SessionSidebarProps {
  sessions: AgentSession[]
  activeSessionId: string | null
  selectSession: (sessionId: string | null) => void
  abortSession: (sessionId: string) => void
  archiveSession: (sessionId: string) => void
  status: 'idle' | 'connecting' | 'connected' | 'disconnected'
}

export default function SessionSidebar({
  sessions,
  activeSessionId,
  selectSession,
  abortSession,
  archiveSession,
  status,
}: SessionSidebarProps) {
  const navigate = useNavigate()

  return (
    <aside className="flex w-[280px] shrink-0 flex-col rounded-lg border border-slate-200 bg-white dark:border-slate-700/50 dark:bg-slate-800">
      {/* New session button */}
      <div className="shrink-0 border-b border-slate-200 p-3 dark:border-slate-700/50">
        <button
          className="btn btn-primary w-full justify-center"
          onClick={() => selectSession(null)}
        >
          <Plus className="h-4 w-4" />
          新建对话
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-xs text-slate-400 dark:text-slate-500">暂无会话</p>
          </div>
        ) : (
          sessions.map((s) => {
            const isActive = s.sessionId === activeSessionId
            return (
              <div
                key={s.sessionId}
                role="button"
                tabIndex={0}
                className={`flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  isActive
                    ? 'bg-indigo-50 dark:bg-indigo-950/40'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/40'
                }`}
                onClick={() => selectSession(s.sessionId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    selectSession(s.sessionId)
                  }
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {s.prNumber ? (
                      <span
                        className="font-mono text-sm font-semibold text-brand-600 dark:text-brand-400 cursor-pointer hover:underline shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/pr/${s.prNumber}`)
                        }}
                      >
                        #{s.prNumber}
                      </span>
                    ) : (
                      <span
                        className={`truncate text-sm font-medium ${
                          isActive
                            ? 'text-indigo-700 dark:text-indigo-400'
                            : 'text-slate-900 dark:text-slate-100'
                        }`}
                        title={s.sessionId}
                      >
                        {truncateId(s.sessionId)}
                      </span>
                    )}
                    {s.prNumber && (
                      <span
                        className="truncate text-xs text-slate-400 dark:text-slate-500"
                        title={s.sessionId}
                      >
                        {truncateId(s.sessionId)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <SessionStatusBadge status={s.status} />
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">
                      {s.messageCount} 条
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">
                      {relativeTime(s.createdAt)}
                    </span>
                  </div>
                </div>

                {/* Abort button for running sessions */}
                {s.status === 'running' && (
                  <button
                    className="mt-0.5 shrink-0 rounded p-1 text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                    onClick={(e) => {
                      e.stopPropagation()
                      // 高危操作:与归档一致,先确认再中止(中止会丢运行状态与消息进度)
                      if (window.confirm('终止该会话？运行中的任务会被中止。')) {
                        abortSession(s.sessionId)
                      }
                    }}
                    title="终止会话"
                  >
                    <Square className="h-3.5 w-3.5" />
                  </button>
                )}

                {/* Archive button */}
                <button
                  className="mt-0.5 shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700/40 dark:hover:text-slate-300"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm('归档该会话？')) {
                      archiveSession(s.sessionId)
                    }
                  }}
                  title="归档"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })
        )}
      </div>

      {/* Connection status footer */}
      <div className="shrink-0 border-t border-slate-200 px-3 py-2 dark:border-slate-700/50">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              status === 'connected'
                ? 'bg-emerald-500'
                : status === 'connecting'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-slate-400'
            }`}
          />
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {status === 'connected'
              ? '已连接'
              : status === 'connecting'
                ? '连接中...'
                : status === 'disconnected'
                  ? '已断开'
                  : '未连接'}
          </span>
        </div>
      </div>
    </aside>
  )
}
