import type { ReactNode } from 'react'
import type { Pr } from '@/lib/api'
import { formatApiErrorEnvelope } from '@/lib/api'

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const formatted = formatApiErrorEnvelope(err, 0)
    // formatApiErrorEnvelope returns "API error: 0" when no fields extractable;
    // fall back to String(err) for non-envelope objects.
    if (formatted !== 'API error: 0') return formatted
  }
  return String(err)
}

export function prStatus(pr: Pr): string {
  // merged/closed 优先于 label 判断(关闭/合并的 PR 可能残留旧标签)
  if (pr.status === 'merged' || pr.merged_at) return 'merged'
  if (pr.status === 'closed') return 'closed'
  // open + needs-fix 标签 → 需修改;必须排在 open 判断之前,否则分支不可达
  if (pr.labels?.some((l) => l.name === 'needs-fix' || l.name === 'needs_fix')) return 'needs_fix'
  return pr.status
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return ''
  // new Date(字符串) 不会抛异常,需自行校验无效日期
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  switch (status) {
    case 'open':
      return <span className="badge badge-purple"><span className="badge-dot" />审核中</span>
    case 'merged':
      return <span className="badge badge-green"><span className="badge-dot" />已合并</span>
    case 'needs_fix':
      return <span className="badge badge-amber"><span className="badge-dot" />需修改</span>
    case 'closed':
      return <span className="badge badge-gray"><span className="badge-dot" />已关闭</span>
    default:
      return <span className="badge badge-gray"><span className="badge-dot" />{status}</span>
  }
}
