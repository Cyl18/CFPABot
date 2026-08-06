/**
 * Normalize a message content to a plain string.
 * Handles arrays from pi-agent events where content may be an array of
 * text blocks ({ text: string }) or plain strings.
 */
export function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c: unknown) => {
      if (typeof c === 'string') return c
      if (c && typeof c === 'object' && 'text' in (c as Record<string, unknown>)) {
        return String((c as Record<string, string>).text)
      }
      return ''
    }).join('')
  }
  return String(content ?? '')
}
