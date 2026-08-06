import { transport, throwApiError } from './client'
import { normalizeRole, type AgentSession, type AgentMessage, type ThinkingLevel } from './types'

const SESSIONS_BASE = '/api/sessions'

async function sessionsGet<T>(path: string): Promise<T> {
  const res = await transport(path, {}, SESSIONS_BASE)
  if (!res.ok) throw await throwApiError(res)
  return res.json()
}

async function sessionsPost<T>(path: string, body: unknown): Promise<T> {
  const res = await transport(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, SESSIONS_BASE)
  if (!res.ok) throw await throwApiError(res)
  return res.json()
}

export const sessionsApi = {
  getSessions: () => sessionsGet<AgentSession[]>(''),
  getSessionMessages: async (sessionId: string) => {
    const { messages } = await sessionsGet<{
      messages: Array<{ role: string; content: string; timestamp: string; thinking?: string; toolName?: string }>
    }>(`/${sessionId}/messages`)
    return {
      messages: messages
        .map((m) => {
          const role = normalizeRole(m.role)
          if (!role) return null
          const msg: AgentMessage = { role, content: m.content }
          if (m.timestamp) msg.timestamp = m.timestamp
          if (typeof m.thinking === 'string') msg.thinking = m.thinking
          if (typeof m.toolName === 'string') msg.toolName = m.toolName
          return msg
        })
        .filter((m): m is NonNullable<typeof m> => m !== null),
    }
  },
  createSession: (data: { message: string; prNumber?: number; objective?: string; modelId?: string; modelProvider?: string; thinkingLevel?: ThinkingLevel }) =>
    sessionsPost<{ sessionId: string; status: string; createdAt: string; error?: string }>('', data),
  sendSessionMessage: (sessionId: string, message: string) =>
    sessionsPost<{ success: boolean }>(`/${sessionId}/messages`, { message }),
  abortSession: (sessionId: string) =>
    sessionsPost<{ success: boolean; sessionId: string }>(`/${sessionId}/abort`, {}),
  confirmAction: (sessionId: string, toolCallId: string) =>
    sessionsPost<{ success: boolean; flowName: string; inputHash: string }>(`/${sessionId}/confirm`, { toolCallId }),
  rejectAction: (sessionId: string, toolCallId: string) =>
    sessionsPost<{ success: boolean }>(`/${sessionId}/reject`, { toolCallId }),
  archiveSession: (sessionId: string) =>
    sessionsPost<{ success: boolean; sessionId: string; status: string; archivedAt?: string }>(`/${sessionId}/archive`, {}),
}

// Re-export the SSE stream base path for useAgentChat / useSseStream
export const SSE_STREAM_BASE = SESSIONS_BASE
