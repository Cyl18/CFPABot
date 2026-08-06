import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  GitPullRequest, GitMerge, AlertCircle, Lock, Activity, RefreshCw,
} from 'lucide-react'
import { api, type Pr } from '@/lib/api'
import { SkeletonBlock, SkeletonStatCard, SkeletonActivityFeed, SkeletonTableRows, SkeletonCard } from '@/components/Skeleton'
import { useAuthStore } from '@/stores/authStore'
import { prStatus, fmtDate, StatusBadge, getErrorMessage } from '@/lib/helpers'
import {
  delay,
  type LoadError,
  activityColors, activityIcons,
} from './dashboard/helpers.tsx'


export default function Dashboard() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const [prs, setPrs] = useState<Pr[]>([])
  const [error, setError] = useState<LoadError | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)

      try {
        const results = await Promise.allSettled([
          api.getPrs('all'),
        ])

        const [prResult] = results

        if (!cancelled) {
          if (prResult.status === 'fulfilled') {
            setPrs(prResult.value)
            if (prResult.value.length === 0) {
              setError({
                message: 'GitHub API 返回空数据',
                detail: '仓库可能无公开 PR，或 API 速率限制已达上限',
              })
            }
          } else {
            setError({
              message: 'PR 数据加载失败',
              detail: String((prResult.reason as Error)?.message || prResult.reason),
            })
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError({ message: '网络请求异常', detail: getErrorMessage(err) })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [refreshKey])
  // Auto-dismiss refresh error banner after 5s
  useEffect(() => {
    if (refreshError) {
      const timer = setTimeout(() => setRefreshError(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [refreshError])

  const openPRs = prs.filter((p) => prStatus(p) === 'open')
  const needsFixPRs = prs.filter((p) => prStatus(p) === 'needs_fix')
  const mergedPRs = prs.filter((p) => prStatus(p) === 'merged')
  const closedPRs = prs.filter((p) => prStatus(p) === 'closed')

  const activity = prs.slice(0, 8).map((pr) => {
    const st = prStatus(pr)
    return {
      status: st,
      color: activityColors[st] || 'text-brand-500',
      Icon: activityIcons[st] || GitPullRequest,
      number: pr.number,
      text: `PR #${pr.number} - ${pr.title.slice(0, 50)}`,
      time: fmtDate(pr.created_at || pr.createdDate),
    }
  })

  // ---- Loading skeleton ----
  if (loading) {
    return (
      <div className="page-enter space-y-6">
        {/* Data source badge skeleton */}
        <SkeletonBlock className="h-5 w-56" />

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <SkeletonStatCard />
          <SkeletonStatCard />
          <SkeletonStatCard />
          <SkeletonStatCard />
        </div>

        {/* Activity feed skeleton */}
        <SkeletonCard>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <SkeletonBlock className="h-5 w-5" />
              <SkeletonBlock className="h-5 w-24" />
            </div>
            <SkeletonBlock className="h-5 w-12 rounded-full" />
          </div>
          <SkeletonActivityFeed items={5} />
        </SkeletonCard>

        {/* Recent PRs table skeleton */}
        <SkeletonCard>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <SkeletonBlock className="h-5 w-5" />
              <SkeletonBlock className="h-5 w-20" />
            </div>
            <SkeletonBlock className="h-4 w-16" />
          </div>
          <SkeletonTableRows rows={5} cols={5} />
        </SkeletonCard>
      </div>
    )
  }

  return (
    <div className="page-enter space-y-6">
      {/* Error banner */}
      {error && (
        <div className="card border-rose-200 bg-rose-50 p-4 dark:border-rose-800 dark:bg-rose-950">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-rose-700 dark:text-rose-400">{error.message}</p>
              <p className="text-sm text-rose-600/80 dark:text-rose-400/80 mt-1 break-all">
                {error.detail}
              </p>
              <button
                className="btn btn-ghost btn-sm mt-2 text-rose-700 dark:text-rose-400"
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="h-3 w-3" />
                重试
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Data source badge + refresh */}
      <div className="flex items-center gap-2 flex-wrap">
        {error ? (
          <span className="badge badge-red"><span className="badge-dot" />● API 错误</span>
        ) : (
          <span className="badge badge-green"><span className="badge-dot" />● 已缓存</span>
        )}
        <span className="text-xs text-slate-400">CFPAOrg/Minecraft-Mod-Language-Package</span>
        {user?.isAdmin && (
          <button
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true)
              setRefreshError(null)
              try {
                await api.refreshPrsCache()
                await delay(2000)
                setRefreshError(null)
                setRefreshKey(k => k + 1)
              } catch (err) {
                setRefreshError(err instanceof Error ? err.message : String(err))
              }
              setRefreshing(false)
            }}
            className="btn btn-ghost btn-sm ml-auto"
            title="手动刷新缓存"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '刷新中...' : '刷新'}
          </button>
        )}
      </div>
      {refreshError && (
        <div className="card border-rose-200 bg-rose-50 p-4 dark:border-rose-800 dark:bg-rose-950">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-rose-700 dark:text-rose-400">缓存刷新失败</p>
              <p className="text-sm text-rose-600/80 dark:text-rose-400/80 mt-1 break-all">
                {refreshError}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="card card-hover p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">已开放</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                {openPRs.length || '-'}
              </p>
            </div>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
              <GitPullRequest className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="card card-hover p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">需修改</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                {needsFixPRs.length || '-'}
              </p>
            </div>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="card card-hover p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">已合并</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                {mergedPRs.length || '-'}
              </p>
            </div>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
              <GitMerge className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="card card-hover p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">已关闭</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                {closedPRs.length || '-'}
              </p>
            </div>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400">
              <Lock className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      {/* Activity Feed */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-brand-600 dark:text-brand-400" />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">最近活动</h2>
          </div>
          <span className="badge badge-gray"><span className="badge-dot" />近期</span>
        </div>
        {activity.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-500 py-4 text-center">暂无活动</p>
        ) : (
          <div className="space-y-0">
            {activity.map((a, i) => (
              <div key={a.number} className="activity-item">
                <a.Icon className={`h-4 w-4 ${a.color} shrink-0 mt-0.5`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 dark:text-slate-300 truncate">{a.text}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{a.time}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent PRs table */}
      <div className="card overflow-hidden">
        <div className="p-6 pb-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <GitPullRequest className="h-5 w-5 text-brand-600 dark:text-brand-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">最近 PR</h2>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/prs')}>
              查看全部
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table-modern">
            <thead>
              <tr>
                <th>PR 编号</th>
                <th>标题</th>
                <th>作者</th>
                <th>状态</th>
                <th>日期</th>
              </tr>
            </thead>
            <tbody>
              {prs.slice(0, 5).map((pr) => (
                <tr
                  key={pr.number}
                  onClick={() => navigate(`/pr/${pr.number}`)}
                  className="cursor-pointer"
                >
                  <td>
                    <span className="font-mono text-sm text-brand-600 dark:text-brand-400">
                      #{pr.number}
                    </span>
                  </td>
                  <td className="max-w-xs truncate">{pr.title}</td>
                  <td className="text-slate-500 dark:text-slate-400">{pr.author}</td>
                  <td><StatusBadge status={prStatus(pr)} /></td>
                  <td className="text-slate-500 dark:text-slate-400">
                    {fmtDate(pr.created_at || pr.createdDate)}
                  </td>
                </tr>
              ))}
              {prs.length === 0 && !error && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 dark:text-slate-500 py-8">
                    暂无 PR 数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
