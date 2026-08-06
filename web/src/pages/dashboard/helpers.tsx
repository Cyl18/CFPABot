import { GitPullRequest, GitMerge, AlertCircle, RefreshCw } from 'lucide-react'
import { prStatus, fmtDate, StatusBadge } from '@/lib/helpers'
/** Minimal delay helper */
export const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))



export interface LoadError {
  message: string
  detail: string
}

export const activityColors: Record<string, string> = {
  open: 'text-emerald-500',
  merged: 'text-purple-500',
  needs_fix: 'text-amber-500',
  closed: 'text-slate-500',
}

export const activityIcons: Record<string, typeof GitPullRequest> = {
  open: GitPullRequest,
  merged: GitMerge,
  needs_fix: AlertCircle,
  closed: RefreshCw,
}
