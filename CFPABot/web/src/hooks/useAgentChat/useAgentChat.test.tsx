import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────
// The hook reaches the backend only through api.*; mock the whole barrel so
// the test never touches the network. useSseStream imports SSE_STREAM_BASE
// from the sessions client — mock that module too.

vi.mock('@/lib/api', () => {
  const api = {
    getSessions: vi.fn(),
    getSessionMessages: vi.fn(),
    createSession: vi.fn(),
    sendSessionMessage: vi.fn(),
    abortSession: vi.fn(),
    confirmAction: vi.fn(),
    rejectAction: vi.fn(),
    archiveSession: vi.fn(),
  }
  return {
    api,
    normalizeRole: (role: string) =>
      role === 'user' || role === 'assistant' || role === 'tool' || role === 'system' ? role : undefined,
  }
})

vi.mock('@/lib/api/sessions', () => ({
  SSE_STREAM_BASE: '/api/sessions',
}))

import { api } from '@/lib/api'
import { useAgentChat, formatToolProgress } from './index'

/** Sleep helper — Promise.withResolvers keeps control flow linear. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

describe('useAgentChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Fresh array instance per call — mirrors res.json() producing a new
    // reference on every fetch. A shared instance would let React bail out
    // of the re-render and mask the loop.
    vi.mocked(api.getSessions).mockImplementation(async () => [])
    vi.mocked(api.getSessionMessages).mockImplementation(async () => ({ messages: [] }))
  })

  it('mounts without an endless session-list refresh loop', async () => {
    renderHook(() => useAgentChat())

    // Let the initial effect run. With the unstable-identity bug the mount
    // effect re-fires after every setSessions re-render, so the call count
    // keeps growing forever.
    await act(async () => {
      await sleep(300)
    })
    const firstCount = vi.mocked(api.getSessions).mock.calls.length
    expect(firstCount).toBeGreaterThan(0) // initial load did happen

    await act(async () => {
      await sleep(300)
    })
    const secondCount = vi.mocked(api.getSessions).mock.calls.length
    expect(secondCount).toBe(firstCount) // …and then it stopped
  })

  it('keeps session callbacks referentially stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useAgentChat())

    const selectSession1 = result.current.selectSession
    const startSession1 = result.current.startSession

    rerender()
    rerender()

    expect(result.current.selectSession).toBe(selectSession1)
    expect(result.current.startSession).toBe(startSession1)
  })
})

// ── formatToolProgress: review_moa onUpdate → display line ─────────────

describe('formatToolProgress', () => {
  const base = { provider: 'openai', modelId: 'gpt-4o' }

  it('renders model_start with total batches', () => {
    expect(formatToolProgress({ ...base, phase: 'model_start', totalBatches: 30 }))
      .toBe('openai/gpt-4o · 开始审查 · 30 batches')
  })

  it('renders batch_done ok with findings count', () => {
    expect(formatToolProgress({
      ...base, phase: 'batch_done', batchIndex: 3, totalBatches: 30, status: 'ok', findings: 5,
    })).toBe('openai/gpt-4o · batch 3/30 · 5 findings')
  })

  it('renders batch_done failed without findings', () => {
    expect(formatToolProgress({
      ...base, phase: 'batch_done', batchIndex: 3, totalBatches: 30, status: 'failed',
    })).toBe('openai/gpt-4o · batch 3/30 失败')
  })

  it('renders model_done with cumulative findings', () => {
    expect(formatToolProgress({
      ...base, phase: 'model_done', totalBatches: 30, status: 'ok', totalFindings: 42,
    })).toBe('openai/gpt-4o · 完成 · 42 findings')
  })

  it('returns null for unknown phases', () => {
    expect(formatToolProgress({ ...base, phase: 'unknown' })).toBeNull()
  })
})
