// web/src/pages/Sessions.tsx
// Main chat page with sidebar and chat area.

import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { useState, useRef, useEffect, useCallback } from 'react'
import { Bot, Send, Square, Loader2 } from 'lucide-react'
import { useAgentChat } from '@/hooks/useAgentChat'
import { truncateId } from './sessions/helpers'
import {
  SessionStatusBadge,
  MessageBubble,
  StreamingIndicator,
  EmptyState,
  WelcomeState,
} from './sessions/components'
import SessionSidebar from './sessions/SessionSidebar'

export default function Sessions() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const {
    sessions,
    activeSessionId,
    messages,
    status,
    isRunning,
    toolProgress,
    error: chatError,
    startSession,
    continueSession,
    abortSession,
    selectSession,
    pendingConfirmation,
    pendingConfirming,
    pendingConfirmError,
    confirmCurrentAction,
    rejectCurrentAction,
    archiveSession,
  } = useAgentChat()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Deep-link: ?session= from PrDetail — select session on mount and on URL re-navigation
  useEffect(() => {
    const sessionId = searchParams.get('session')
    if (sessionId && sessionId !== activeSessionId) {
      selectSession(sessionId)
    }
  }, [searchParams, activeSessionId, selectSession])

  // Sync: clear ?session= param from URL once user interacts (sidebar click, new session, created session)
  useEffect(() => {
    if (activeSessionId && searchParams.has('session')) {
      navigate('/agent', { replace: true })
    }
  }, [activeSessionId, searchParams, navigate])

  const currentMessages = activeSessionId ? (messages[activeSessionId] ?? []) : []

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [currentMessages.length, isRunning])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
    }
  }, [input])

  // No active session: only need text + not running/pending (no EventSource yet, status='idle')
  // Active session: also require SSE connection
  const canSend = input.trim().length > 0 && !isRunning && !pendingConfirmation
    && (!activeSessionId || status === 'connected')

  /** Send the current input as a message. */
  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || isRunning || pendingConfirmation) return
    // Active session requires SSE connection; no session doesn't
    if (activeSessionId && status !== 'connected') return

    if (activeSessionId) {
      continueSession(activeSessionId, text)
    } else {
      // No per-session model selection: server resolves model from configured defaults.
      startSession(text)
    }
    setInput('')
  }, [input, isRunning, activeSessionId, continueSession, startSession, pendingConfirmation, status])

  /** Handle keyboard shortcut: Ctrl/Cmd + Enter to send. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  /** Find the currently active session object. */
  const activeSession = activeSessionId
    ? sessions.find((s) => s.sessionId === activeSessionId)
    : null

  /** Render a bounded JSON/text preview for pending confirmation input. */
  function renderInputPreview(input: unknown): React.ReactNode {
    if (input === undefined || input === null) return null
    try {
      const raw = typeof input === 'string' ? input : JSON.stringify(input, null, 1)
      // Truncate at ~2 KiB for safety, avoid allocating the full string twice
      const MAX_LEN = 2048
      const preview = raw.length > MAX_LEN ? raw.slice(0, MAX_LEN) + '…' : raw
      return <pre className="mt-1 rounded bg-amber-100/60 p-1.5 font-mono text-[11px] leading-relaxed dark:bg-amber-900/20 whitespace-pre-wrap break-all">{preview}</pre>
    } catch {
      return <p className="mt-1 text-xs text-amber-600">(无法解析输入数据)</p>
    }
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <div className="mb-4 flex shrink-0 items-center gap-3">
        <Bot className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Agent
        </h1>
        {status === 'disconnected' && (
          <span className="badge badge-red">
            <span className="badge-dot" />
            已断开
          </span>
        )}
      </div>

      {/* Chat layout: sidebar + main area */}
      <div className="flex flex-1 gap-4 overflow-hidden">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          selectSession={selectSession}
          abortSession={abortSession}
          archiveSession={archiveSession}
          status={status}
        />

        {/* ── Main chat area ──────────────────────────── */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700/50 dark:bg-slate-800">
          {/* Top bar */}
          <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700/50">
            {activeSession ? (
              <>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Bot className="h-4 w-4 shrink-0 text-brand-600 dark:text-brand-400" />
                  <span
                    className="truncate text-sm font-mono text-slate-700 dark:text-slate-300"
                    title={activeSession.sessionId}
                  >
                    {truncateId(activeSession.sessionId)}
                  </span>
                  {activeSession.modelId && (
                    <span className="hidden truncate text-xs text-slate-400 sm:inline">
                      {activeSession.modelProvider ? `${activeSession.modelProvider}/` : ''}
                      {activeSession.modelId}
                    </span>
                  )}
                </div>
                {activeSession.prNumber && (
                  <Link
                    to={`/pr/${activeSession.prNumber}`}
                    className="inline-flex items-center gap-1 text-xs text-brand-600 dark:text-brand-400 hover:underline shrink-0"
                    title="查看关联 PR"
                  >
                    #{activeSession.prNumber}
                  </Link>
                )}
                <SessionStatusBadge status={activeSession.status} />
                {isRunning && (
                  <button
                    className="btn btn-red btn-sm"
                    onClick={() => abortSession(activeSession.sessionId)}
                    title="终止"
                  >
                    <Square className="h-3 w-3" />
                    终止
                  </button>
                )}
              </>
            ) : (
              <span className="text-sm text-slate-500 dark:text-slate-400">
                未选择会话
              </span>
            )}
          </div>

          {/* Error banner */}
          {chatError && (
            <div className="mx-4 mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
              {chatError}
            </div>
          )}

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {!activeSessionId ? (
              <EmptyState />
            ) : currentMessages.length === 0 && !isRunning ? (
              <WelcomeState />
            ) : (
              <div className="space-y-3">
                {currentMessages.map((msg, i) => (
                  <MessageBubble key={`${msg.role}-${i}`} message={msg} />
                ))}
                {toolProgress.length > 0 && (
                  <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
                    {toolProgress.map((p) => (
                      <div key={p.toolCallId} className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                        <span className="shrink-0 font-medium">{p.toolName}</span>
                        <span className="truncate">{p.text}</span>
                      </div>
                    ))}
                  </div>
                )}
                {isRunning && <StreamingIndicator />}
                <div ref={messagesEndRef} />
              </div>
            )}

            {/* Pending confirmation card — requires user action to proceed */}
            {pendingConfirmation && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/40 dark:bg-amber-950/30">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">需要确认</span>
                  <span className="badge badge-amber"><span className="badge-dot" />待确认</span>
                </div>
                <div className="space-y-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <p><span className="font-medium">操作：</span>{pendingConfirmation.flowName}</p>
                  <p className="break-all font-mono text-[11px]">{pendingConfirmation.toolCallId}</p>
                  {renderInputPreview(pendingConfirmation.input)}
                </div>
                {pendingConfirmError && (
                  <p className="mt-2 text-xs text-red-600 dark:text-red-400">{pendingConfirmError}</p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={confirmCurrentAction}
                    disabled={pendingConfirming}
                  >
                    {pendingConfirming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    确认执行
                  </button>
                  <button
                    className="btn btn-ghost btn-sm text-slate-600 dark:text-slate-400"
                    onClick={rejectCurrentAction}
                    disabled={pendingConfirming}
                  >
                    拒绝
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="shrink-0 border-t border-slate-200 p-4 dark:border-slate-700/50">
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  pendingConfirmation
                    ? '请先确认或拒绝上方操作'
                    : activeSessionId
                      ? '输入消息… (Ctrl+Enter 发送)'
                      : '输入消息开始新对话… (Ctrl+Enter 发送)'
                }
                disabled={isRunning || !!pendingConfirmation || (!!activeSessionId && status !== 'connected')}
                className="form-control min-h-[40px] max-h-[160px] resize-none"
              />
              <button
                className="btn btn-primary h-10 w-10 shrink-0 justify-center rounded-lg p-0"
                disabled={!canSend}
                onClick={handleSend}
                title="发送"
              >
                {isRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
            {pendingConfirmation && (
              <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                请先确认或拒绝上方操作
              </p>
            )}
            {isRunning && !pendingConfirmation && (
              <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                Agent 正在处理，请等待当前轮次完成
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
