import { AuthError } from './types'

/** Handle 401 by redirecting to OAuth. */
function handleAuth(res: Response): never {
  window.location.href = '/api/oauth/github'
  throw new AuthError()
}

/** Request timeout in milliseconds. */
export const TIMEOUT_MS = 30_000

/**
 * Format an API error envelope into a human-readable message.
 * Handles response bodies shaped as { error, detail?, code? } or { message },
 * falling back to the HTTP status. Shared by all request helpers.
 */
export function formatApiErrorEnvelope(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    const err = typeof obj.error === 'string' ? obj.error : ''
    const message = typeof obj.message === 'string' ? obj.message : ''
    const detail = typeof obj.detail === 'string' && obj.detail ? obj.detail : ''
    const code = typeof obj.code === 'string' ? obj.code : ''
    const primary = err || message
    const parts = [primary, detail].filter(Boolean)
    const msg = parts.length ? parts.join(' - ') : ''
    if (msg) return code ? `${msg} (${code})` : msg
    if (code) return code
  }
  return `API error: ${status}`
}

/**
 * Throw an Error for a failed response, parsing the error envelope
 * ({ error, message, detail?, code? }) from the body when possible.
 * Shared by all request helpers; falls back to the HTTP status.
 */
export async function throwApiError(res: Response): Promise<never> {
  let msg = `API error: ${res.status}`
  try {
    const body = await res.json()
    msg = `API error: ${res.status} - ${formatApiErrorEnvelope(body, res.status)}`
  } catch { /* ignore parse failures */ }
  throw new Error(msg)
}

/**
 * Shared fetch transport: builds the absolute URL, applies credentials +
 * timeout, merges caller init, and converts 401 into an OAuth redirect +
 * AuthError throw. Returns the Response so each wrapper can enforce its own
 * error semantics (apiPostJson intentionally does not throw on !ok).
 */
export function transport(input: string, init: RequestInit, base: string): Promise<Response> {
  const res = fetch(`${base}${input}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
  })
  return res.then((r) => {
    if (r.status === 401) handleAuth(r)
    return r
  })
}

export async function apiGet<T>(path: string, base: string): Promise<T> {
  const res = await transport(path, {}, base)
  if (!res.ok) throw await throwApiError(res)
  return res.json()
}

export async function apiPost<T>(path: string, body: unknown, base: string): Promise<T> {
  const res = await transport(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, base)
  if (!res.ok) throw await throwApiError(res)
  return res.json()
}

export async function apiPostJson<T>(path: string, body: unknown, base: string): Promise<T> {
  const res = await transport(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, base)
  return res.json() as Promise<T>
}

export async function apiPut<T>(path: string, body: unknown, base: string): Promise<T> {
  const res = await transport(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, base)
  if (!res.ok) throw await throwApiError(res)
  return res.json()
}

export async function apiDel<T>(path: string, base: string): Promise<T> {
  const res = await transport(path, { method: 'DELETE' }, base)
  if (!res.ok) throw await throwApiError(res)
  return res.json()
}

export async function apiFetchBlob(path: string, base: string): Promise<Blob | undefined> {
  const res = await transport(path, {}, base)
  if (!res.ok) throw await throwApiError(res)
  return res.blob()
}
