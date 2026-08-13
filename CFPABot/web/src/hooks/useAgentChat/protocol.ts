import type { AgentSession, AgentMessage, PendingConfirmation } from '@/lib/api'

/** Maximum reconnection attempts before giving up. */
export const MAX_RECONNECT = 5
/** Initial reconnection delay in ms. */
export const INITIAL_DELAY = 3000

/** One live tool-execution progress line (e.g. review_moa batch progress). */
export interface ToolProgressEntry {
  toolCallId: string
  toolName: string
  text: string
}

export interface UseAgentChatReturn {
  /** All active sessions. */
  sessions: AgentSession[]
  /** Currently selected session ID (or null). */
  activeSessionId: string | null
  /** Accumulated messages per session (keyed by sessionId). */
  messages: Record<string, AgentMessage[]>
  /** SSE connection status. */
  status: 'idle' | 'connecting' | 'connected' | 'disconnected'
  /** Whether the active session is awaiting agent response. */
  isRunning: boolean
  /** Tool execution progress lines for the active session (newest last). */
  toolProgress: ToolProgressEntry[]
  /** Error message from last operation, or null. */
  error: string | null
  /** Start a new chat session. */
  startSession: (message: string) => void
  /** Continue an existing session with a follow-up message. */
  continueSession: (sessionId: string, message: string) => void
  /** Abort a running session. */
  abortSession: (sessionId: string) => void
  /** Archive a session (soft-delete). */
  archiveSession: (sessionId: string) => void

  /** Select a session (loads its message history + opens SSE). */
  selectSession: (sessionId: string | null) => void
  /** Refresh the session list. */
  refreshSessions: () => void
  /** Subscribe to raw SSE events. Returns unsubscribe function. */
  subscribe: (listener: (event: Record<string, unknown>) => void) => () => void
  /** Pending tool-use confirmation for the active session, or null. */
  pendingConfirmation: PendingConfirmation | null
  /** True while confirm/reject API call is in flight. */
  pendingConfirming: boolean
  /** Error from the last confirm/reject attempt. */
  pendingConfirmError: string | null
  /** Confirm the pending action — calls API, clears pending, sets isRunning. */
  confirmCurrentAction: () => void
  /** Reject the pending action — calls API, clears pending, refreshes history. */
  rejectCurrentAction: () => void
}
