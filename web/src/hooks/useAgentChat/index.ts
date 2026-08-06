import { useState, useRef, useCallback, useEffect } from 'react'
import { api, normalizeRole, type AgentSession, type AgentMessage, type PendingConfirmation } from '@/lib/api'
import { MAX_RECONNECT, INITIAL_DELAY, type ToolProgressEntry, type UseAgentChatReturn } from './protocol'
import { normalizeContent } from './normalize'
import { useSseStream, type SseStatus } from './useSseStream'

/**
 * Custom hook for agent chat via SSE + POST (no WebSocket).
 *
 * Architecture:
 * - GET  /api/sessions/:sessionId/stream  → SSE EventSource for server events (via useSseStream)
 * - POST /api/sessions                    → create new session
 * - POST /api/sessions/:sessionId/messages → send message (continue)
 * - POST /api/sessions/:sessionId/abort    → abort
 * - GET  /api/sessions                    → list all sessions
 * - GET  /api/sessions/:sessionId         → get session with messages
 *
 * W3: SSE stream lifecycle is delegated to useSseStream. useAgentChat composes it
 * and keeps handling agent events, message buffering, pending confirm, session list.
 */

/** Render a tool progress details payload (review_moa onUpdate) into a display line. */
export function formatToolProgress(details: Record<string, unknown>): string | null {
  const provider = typeof details.provider === 'string' ? details.provider : '?'
  const modelId = typeof details.modelId === 'string' ? details.modelId : '?'
  const model = `${provider}/${modelId}`
  const total = typeof details.totalBatches === 'number' ? details.totalBatches : 0
  switch (details.phase) {
    case 'model_start':
      return `${model} · 开始审查 · ${total} batches`
    case 'batch_done': {
      const bi = typeof details.batchIndex === 'number' ? details.batchIndex : 0
      if (details.status === 'failed') return `${model} · batch ${bi}/${total} 失败`
      const findings = typeof details.findings === 'number' ? details.findings : 0
      return `${model} · batch ${bi}/${total} · ${findings} findings`
    }
    case 'model_done': {
      const n = typeof details.totalFindings === 'number' ? details.totalFindings : 0
      return `${model} · ${details.status === 'failed' ? '失败' : '完成'} · ${n} findings`
    }
    default:
      return null
  }
}

export function useAgentChat(): UseAgentChatReturn {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [toolProgress, setToolProgress] = useState<Record<string, ToolProgressEntry>>({})
  const [messages, setMessages] = useState<Record<string, AgentMessage[]>>({})
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null)
  const [pendingConfirming, setPendingConfirming] = useState(false)
  const [pendingConfirmError, setPendingConfirmError] = useState<string | null>(null)
  // Refs
  const activeSessionIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  /** 新会话创建 in-flight 锁:防止双击/连按创建两个会话 */
  const creatingRef = useRef(false)
  /** 上一次 SSE 状态(检测断线后重连成功) */
  const prevSseStatusRef = useRef<SseStatus>('idle')

  /** Per-session buffer for SSE events arriving before history GET completes. */
  const pendingHistoryRef = useRef<Map<string, { reqId: number; buffer: AgentMessage[] }>>(new Map())
  /** Monotonically increasing request ID for history fetches — newer reqId supersedes older. */
  const loadReqIdRef = useRef(0)

  // W3: SSE stream lifecycle — useSseStream owns EventSource + reconnect
  const sse = useSseStream()

  /** Validate and sync pendingConfirmation from an SSE data payload. */
  const syncPendingConfirmation = useCallback((data: Record<string, unknown>) => {
    const pc = data.pendingConfirmation
    if (pc === null || pc === undefined) {
      setPendingConfirmation(null)
    } else if (typeof pc === 'object' && pc !== null) {
      const obj = pc as Record<string, unknown>
      if (typeof obj.toolCallId === 'string' && typeof obj.flowName === 'string') {
        setPendingConfirmation({ toolCallId: obj.toolCallId, flowName: obj.flowName, input: obj.input })
      }
    }
  }, [])

  /** Handle an agent event from the SSE stream. */
  const handleAgentEvent = useCallback((data: Record<string, unknown>) => {
    const sid = data.sessionId as string | undefined
    if (!sid) return
    const type = data.type as string

    if (type === 'message_end' && data.message) {
      const msg = data.message as Record<string, unknown>
      const role = normalizeRole((msg.role as string) ?? '')

      if (role && role !== 'user') {
        let content = normalizeContent(msg.content)

        // Empty content handling
        if (!content) {
          if (role === 'tool') {
            const toolName = typeof msg.toolName === 'string' ? msg.toolName : 'unknown'
            content = `[tool result: ${toolName}]`
          } else {
            return // toolCall-only turns, no visible content
          }
        }

        // Normalize timestamp: pi-agent sends ms-number; convert to ISO string
        const rawTs = msg.timestamp
        let timestamp: string | undefined
        if (typeof rawTs === 'number') {
          timestamp = new Date(rawTs).toISOString()
        } else if (typeof rawTs === 'string') {
          timestamp = rawTs
        }
        const entry: AgentMessage = { role, content }
        if (timestamp) entry.timestamp = timestamp
        if (typeof msg.thinking === 'string') entry.thinking = msg.thinking
        if (typeof msg.toolName === 'string') entry.toolName = msg.toolName

        // History still loading for this session? Buffer the event
        const pending = pendingHistoryRef.current.get(sid)
        if (pending) {
          pending.buffer.push(entry)
          return
        }

        setMessages((prev) => ({
          ...prev,
          [sid]: [...(prev[sid] ?? []), entry],
        }))
      }
    }

    // ── Global state updates — only for the currently active session ──
    const isActive = sid === activeSessionIdRef.current

    if (type === 'agent_start' && isActive) {
      setIsRunning(true)
    }

    // Tool execution progress (e.g. review_moa batch progress via onUpdate).
    if (type === 'tool_execution_update' && isActive) {
      const toolCallId = data.toolCallId
      const toolName = data.toolName
      if (typeof toolCallId === 'string' && typeof toolName === 'string') {
        const partialResult = data.partialResult
        const details =
          partialResult && typeof partialResult === 'object' && 'details' in partialResult
            ? partialResult.details
            : undefined
        if (details && typeof details === 'object') {
          const text = formatToolProgress(details as Record<string, unknown>)
          if (text) {
            setToolProgress((prev) => ({ ...prev, [toolCallId]: { toolCallId, toolName, text } }))
          }
        }
      }
    }
    // Tool finished — drop its progress line.
    if (type === 'tool_execution_end' && isActive) {
      const toolCallId = data.toolCallId
      if (typeof toolCallId === 'string') {
        setToolProgress((prev) => {
          if (!(toolCallId in prev)) return prev
          const next = { ...prev }
          delete next[toolCallId]
          return next
        })
      }
    }

    // session_status from initial SSE connection: generic status sync for any status value
    if (type === 'session_status') {
      const sessionStatus = data.status as string
      // Always update sidebar session list with server-provided status
      setSessions((prev) => prev.map((s) =>
        s.sessionId === sid ? { ...s, status: sessionStatus } : s
      ))
      if (isActive) {
        setIsRunning(sessionStatus === 'running')
        if (typeof data.error === 'string' && data.error) {
          setError(data.error)
        }
        // Sync pendingConfirmation only for the active session; stale session_status must not pollute current
        syncPendingConfirmation(data)
      }
    }

    // pending_confirmation SSE event: top-level fields {toolCallId, flowName, input}
    if (type === 'pending_confirmation') {
      if (isActive) {
        if (typeof data.toolCallId === 'string' && typeof data.flowName === 'string') {
          setPendingConfirmation({ toolCallId: data.toolCallId, flowName: data.flowName, input: data.input })
          setIsRunning(false)
        }
      }
      setSessions((prev) => prev.map((s) =>
        s.sessionId === sid ? { ...s, status: 'running' } : s
      ))
    }

    // Terminal status: always update sidebar session list, but isRunning/error only for active session.
    // Only clear pendingConfirmation for the active session (stale events must not pollute current session).
    if (type === 'idle') {
      if (isActive) {
        setPendingConfirmation(null)
        setIsRunning(false)
        setToolProgress({})
      }
      setSessions((prev) => prev.map((s) =>
        s.sessionId === sid ? { ...s, status: 'idle' } : s
      ))
    }
  }, [syncPendingConfirmation])

  // W3: Subscribe to raw SSE events from useSseStream
  useEffect(() => {
    const unsub = sse.subscribe((data) => {
      if (data.sessionId) {
        handleAgentEvent(data)
      }
    })
    return unsub
  }, [sse.subscribe, handleAgentEvent])

  /** Clean up SSE and reconnect timer. */
  const cleanup = useCallback(() => {
    sse.close()
  }, [sse.close])

  /** Fetch session list from REST API. */
  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.getSessions()
      setSessions(list)

      // Sync isRunning with active session status
      const active = activeSessionIdRef.current
      if (active) {
        const activeSess = list.find((s) => s.sessionId === active)
        if (activeSess) {
          setIsRunning(activeSess.status === 'running')
        }
      }
    } catch (err) {
      console.warn('[AgentChat] Failed to fetch sessions:', err)
    }
  }, [])

  /**
   * Shared flow: set up pending buffer → open SSE stream → GET history → merge history+buffer.
   * Used by both startSession (new session) and selectSession (existing session).
   * On GET success, server history replaces any local seed (e.g. startSession's user message).
   * On GET failure, any local seed + buffered SSE events are preserved.
   *
   * During merge, buffered events with a stable (role, timestamp) key already present in history
   * are skipped to avoid duplicating SSE messages that the server already persisted before the GET.
   */
  const loadSessionHistory = useCallback(async (sessionId: string, reqId: number) => {
    try {
      const { messages: raw } = await api.getSessionMessages(sessionId)
      const msgs = raw.filter((m) => m !== null) as AgentMessage[]
      const entry = pendingHistoryRef.current.get(sessionId)
      if (entry && entry.reqId === reqId) {
        // Build a set of known (role, timestamp) keys from server history
        const seen = new Set<string>()
        for (const m of msgs) {
          if (m.timestamp) seen.add(`${m.role}:${m.timestamp}`)
        }
        // Drop buffered events that already match a history entry; keep those without timestamp
        const filtered = entry.buffer.filter((b) => {
          if (!b.timestamp) return true
          return !seen.has(`${b.role}:${b.timestamp}`)
        })
        setMessages((prev) => ({
          ...prev,
          [sessionId]: [...msgs, ...filtered],
        }))
        pendingHistoryRef.current.delete(sessionId)
      }
    } catch (err) {
      const entry = pendingHistoryRef.current.get(sessionId)
      if (entry && entry.reqId === reqId) {
        if (entry.buffer.length > 0) {
          setMessages((prev) => ({
            ...prev,
            [sessionId]: [...(prev[sessionId] ?? []), ...entry.buffer],
          }))
        }
        pendingHistoryRef.current.delete(sessionId)
        setError(err instanceof Error ? err.message : String(err))
      }
      console.warn('[AgentChat] Failed to load messages:', err)
    }
  }, [])

  const startSession = useCallback(
    async (message: string) => {
      // 创建中直接忽略(双击/连按 Ctrl+Enter)
      if (creatingRef.current) return
      creatingRef.current = true
      setError(null)
      try {
        const result = await api.createSession({ message })
        const { sessionId } = result
        // Backend returns error field on model init failure etc.
        const failed = !!result.error
        if (failed) {
          setError(result.error || '创建会话失败')
          setIsRunning(false)
        } else {
          setIsRunning(true)
        }
        setActiveSessionId(sessionId)
        // Write the initial user message immediately so it's visible before SSE/GET arrive
        setMessages((prev) => ({
          ...prev,
          [sessionId]: [{ role: 'user' as const, content: message }],
        }))

        // Activate the shared history-loading flow (buffer SSE → open stream → GET → merge)
        const reqId = ++loadReqIdRef.current
        pendingHistoryRef.current.set(sessionId, { reqId, buffer: [] })
        sse.open(sessionId)
        await loadSessionHistory(sessionId, reqId)

        // Refresh sidebar list now that SSE subscription is up and history loaded
        // (avoid racing with SSE-terminal broadcast or stale pre-subscription snapshot)
        await refreshSessions()

      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        console.error('[AgentChat] Failed to start session:', err)
      } finally {
        creatingRef.current = false
      }
    },
    [refreshSessions, sse.open, loadSessionHistory])
  /** Continue an existing session with a follow-up message. */
  const continueSession = useCallback(
    async (sessionId: string, message: string) => {
      setError(null)
      // Optimistically add user message
      setMessages((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), { role: 'user' as const, content: message }],
      }))
      setIsRunning(true)

      try {
        await api.sendSessionMessage(sessionId, message)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setIsRunning(false)
        // 精确回滚乐观消息:按 (role, content) 删除最后一次匹配,不受
        // 期间迟到的 message_end 追加影响
        setMessages((prev) => {
          const arr = prev[sessionId] ?? []
          const idx = arr.map((m) => `${m.role}:${m.content}`).lastIndexOf(`user:${message}`)
          if (idx === -1) return prev
          return { ...prev, [sessionId]: arr.filter((_, i) => i !== idx) }
        })
      }
    },
    [],
  )

  /** Abort a running session. */
  const abortSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionIdRef.current) {
        setIsRunning(false)
      }
      try {
        await api.abortSession(sessionId)
        await refreshSessions()
      } catch (err) {
        if (sessionId === activeSessionIdRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
        console.warn('[AgentChat] Failed to abort session:', err)
      }
    },
    [refreshSessions],
  )

  /** Select a session — opens SSE stream and loads history. */
  const selectSession = useCallback(
    async (sessionId: string | null) => {
      setError(null)
      setPendingConfirmation(null)
      setPendingConfirmError(null)
      setPendingConfirming(false)
      setActiveSessionId(sessionId)
      if (sessionId) {
        const reqId = ++loadReqIdRef.current
        pendingHistoryRef.current.set(sessionId, { reqId, buffer: [] })
        sse.open(sessionId)
        await loadSessionHistory(sessionId, reqId)
      } else {
        cleanup()
        setIsRunning(false)
      }
    },
    [sse.open, cleanup, loadSessionHistory],
  )

  /** Subscribe to raw SSE events. Returns unsubscribe function. */
  const subscribe = useCallback((listener: (event: Record<string, unknown>) => void) => {
    return sse.subscribe(listener)
  }, [sse.subscribe])

  /** Confirm the pending tool action — calls API, clears pending, sets isRunning. */
  const confirmCurrentAction = useCallback(async () => {
    const sid = activeSessionIdRef.current
    const pc = pendingConfirmation
    if (!sid || !pc) return
    setPendingConfirmError(null)
    setPendingConfirming(true)
    try {
      await api.confirmAction(sid, pc.toolCallId)
      // Only flip global state if still the active session
      if (activeSessionIdRef.current === sid) {
        setPendingConfirmation(null)
        setIsRunning(true)
      }
      await refreshSessions()
    } catch (err) {
      if (activeSessionIdRef.current === sid) {
        setPendingConfirmError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setPendingConfirming(false)
    }
  }, [pendingConfirmation, refreshSessions])

  /** Reject the pending tool action — calls API, clears pending, refreshes history. */
  const rejectCurrentAction = useCallback(async () => {
    const sid = activeSessionIdRef.current
    const pc = pendingConfirmation
    if (!sid || !pc) return
    setPendingConfirmError(null)
    setPendingConfirming(true)
    try {
      await api.rejectAction(sid, pc.toolCallId)
      // Only flip global state if still the active session
      if (activeSessionIdRef.current === sid) {
        setPendingConfirmation(null)
        setIsRunning(false)
      }
      // Re-fetch history so the system rejection message appears (safe regardless of active session)
      const { messages: msgs } = await api.getSessionMessages(sid)
      setMessages((prev) => ({ ...prev, [sid]: msgs }))
      // Refresh sidebar session list (safe regardless of active session)
      await refreshSessions()
    } catch (err) {
      if (activeSessionIdRef.current === sid) {
        setPendingConfirmError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setPendingConfirming(false)
    }
  }, [pendingConfirmation, refreshSessions])

  /** Archive a session: soft-delete, remove from lists, clear active if needed. */
  const archiveSession = useCallback(
    async (sessionId: string) => {
      try {
        await api.archiveSession(sessionId)
        setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId))
        setMessages((prev) => {
          const rest: Record<string, AgentMessage[]> = {}
          for (const k in prev) {
            if (k !== sessionId) rest[k] = prev[k]
          }
          return rest
        })
        if (activeSessionIdRef.current === sessionId) {
          setActiveSessionId(null)
          setPendingConfirmation(null)
          cleanup()
          setIsRunning(false)
        }
      } catch (err) {
        console.warn('[AgentChat] Failed to archive session:', err)
        if (activeSessionIdRef.current === sessionId) {
          const errMsg = err instanceof Error ? err.message : String(err)
          setMessages((prev) => ({
            ...prev,
            [sessionId]: [...(prev[sessionId] ?? []), { role: 'system', content: `归档失败: ${errMsg}` }],
          }))
        }
      }
    },
    [cleanup],
  )

  // Keep ref in sync with state so async handlers (SSE reconnect, refreshSessions,
  // abort/confirm/reject) can read the current active session without stale closures.
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
  }, [activeSessionId])

  // 断线重连成功后重新拉取历史,补上断线期间丢失的消息
  // (后端重连时不重放历史,只发 session_status)
  useEffect(() => {
    const prev = prevSseStatusRef.current
    prevSseStatusRef.current = sse.status
    if (prev === 'disconnected' && sse.status === 'connected' && activeSessionIdRef.current) {
      const sid = activeSessionIdRef.current
      const reqId = ++loadReqIdRef.current
      pendingHistoryRef.current.set(sid, { reqId, buffer: [] })
      void loadSessionHistory(sid, reqId)
    }
  }, [sse.status, loadSessionHistory])

  // Initial fetch + cleanup
  useEffect(() => {
    // StrictMode dev double-mount runs setup → cleanup → setup; reset guard so reconnect works
    mountedRef.current = true
    refreshSessions()
    return () => {
      mountedRef.current = false
      pendingHistoryRef.current.clear()
      cleanup()
    }
  }, [refreshSessions, cleanup])

  return {
    sessions,
    activeSessionId,
    messages,
    status: sse.status,
    isRunning,
    toolProgress: Object.values(toolProgress),
    error,
    startSession,
    continueSession,
    abortSession,
    selectSession,
    refreshSessions,
    subscribe,
    pendingConfirmation,
    pendingConfirming,
    pendingConfirmError,
    confirmCurrentAction,
    rejectCurrentAction,
    archiveSession,
  }
}
