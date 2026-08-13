/** Format an ISO timestamp as a relative time string in Chinese. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return iso.slice(0, 10)
}

/** Truncate a sessionId for sidebar display. */
export function truncateId(id: string): string {
  if (id.length <= 20) return id
  return `${id.slice(0, 10)}…${id.slice(-6)}`
}
