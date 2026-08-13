import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { SSE_STREAM_BASE } from '@/lib/api/sessions'
import { MAX_RECONNECT, INITIAL_DELAY } from './protocol'

export type SseStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

interface UseSseStreamReturn {
  /** Current SSE connection status. */
  status: SseStatus
  /** Open the SSE stream for a given session. */
  open: (sessionId: string) => void
  /** Close the SSE stream and cancel any pending reconnect. */
  close: () => void
  /** Subscribe to raw SSE events. Returns unsubscribe function. */
  subscribe: (listener: (event: Record<string, unknown>) => void) => () => void
}

/**
 * SSE connection + reconnect (exponential backoff) + event dispatch.
 * Extracted from useAgentChat so the stream lifecycle is independently testable.
 *
 * Status state machine:
 *   idle → connecting (on open())
 *   connecting → connected (on EventSource open)
 *   connected → disconnected (on EventSource error)
 *   disconnected → connecting (on reconnect timer fire)
 *   any → idle (on close())
 */
export function useSseStream(): UseSseStreamReturn {
  const [status, setStatus] = useState<SseStatus>('idle')
  const esRef = useRef<EventSource | null>(null)
  const reconnectCount = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const activeSessionIdRef = useRef<string | null>(null)
  const listenersRef = useRef<Set<(event: Record<string, unknown>) => void>>(new Set())
  const mountedRef = useRef(true)

  const close = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = undefined
    }
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }, [])

  const open = useCallback((sessionId: string) => {
    // 组件已卸载(await createSession 期间离开页面等)时不再新建连接
    if (!mountedRef.current) return
    // Close existing stream
    close()

    activeSessionIdRef.current = sessionId
    setStatus('connecting')

    const es = new EventSource(`${SSE_STREAM_BASE}/${sessionId}/stream`, {
      withCredentials: true,
    })
    esRef.current = es

    es.onopen = () => {
      setStatus('connected')
      reconnectCount.current = 0
    }

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>
        listenersRef.current.forEach((fn) => fn(data))
      } catch {
        // Ignore malformed messages
      }
    }

    es.onerror = () => {
      // EventSource 出错后 readyState 是 CONNECTING(浏览器内置无限重连),
      // 与自定义退避冲突 —— 先显式关闭,让下面的自定义重连(有上限)接管
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
      setStatus('disconnected')

      if (!mountedRef.current) return
      if (reconnectCount.current >= MAX_RECONNECT) {
        console.warn('[useSseStream] Max SSE reconnection attempts reached')
        return
      }

      reconnectCount.current++
      const delay = INITIAL_DELAY * Math.pow(2, reconnectCount.current - 1)
      reconnectTimer.current = setTimeout(() => {
        if (!activeSessionIdRef.current || !mountedRef.current) return
        open(activeSessionIdRef.current)
      }, delay)
    }
  }, [close])

  const subscribe = useCallback((listener: (event: Record<string, unknown>) => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      listenersRef.current.clear()
      close()
    }
  }, [close])

  // Memoize the returned object: open/close/subscribe are stable useCallbacks,
  // so identity only changes when status does. Consumers that put `sse` in
  // effect/callback deps would otherwise get a fresh object every render and
  // re-run their effects in an endless loop.
  return useMemo(
    () => ({ status, open, close, subscribe }),
    [status, open, close, subscribe],
  )
}
