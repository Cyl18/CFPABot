import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitPullRequest, RefreshCw } from 'lucide-react'
import { api, type Pr } from '@/lib/api'
import { SkeletonBlock, SkeletonCard, SkeletonTableRows } from '@/components/Skeleton'
import { prStatus, fmtDate, StatusBadge, getErrorMessage } from '@/lib/helpers'


const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '审核中' },
  { key: 'needs_fix', label: '需修改' },
  { key: 'merged', label: '已合并' },
  { key: 'closed', label: '已关闭' },
] as const

// ---- Component ----

export default function PrList() {
  const navigate = useNavigate()
  const [prs, setPrs] = useState<Pr[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await api.getPrs('all')
        if (!cancelled) {
          setPrs(data)
          if (data.length === 0) {
            setError('暂无可显示的 PR 数据')
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err) || '加载失败')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [refreshKey])

  const filtered = useMemo(() => {
    if (filter === 'all') return prs
    return prs.filter((pr) => prStatus(pr) === filter)
  }, [prs, filter])

  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    setRefreshKey(k => k + 1)
  }, [])

  if (loading) {
    return (
      <div className="page-enter space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <SkeletonBlock className="h-6 w-6" />
          <SkeletonBlock className="h-7 w-32" />
        </div>

        {/* Filter chips */}
        <div className="flex gap-2">
          <SkeletonBlock className="h-8 w-14 rounded-full" />
          <SkeletonBlock className="h-8 w-16 rounded-full" />
          <SkeletonBlock className="h-8 w-16 rounded-full" />
          <SkeletonBlock className="h-8 w-16 rounded-full" />
          <SkeletonBlock className="h-8 w-16 rounded-full" />
        </div>

        {/* Count */}
        <SkeletonBlock className="h-4 w-32" />

        {/* Table */}
        <SkeletonCard className="!p-0 overflow-hidden">
          <SkeletonTableRows rows={8} cols={6} colWidths={['w-16', 'w-56', 'w-20', 'w-24', 'w-24', 'w-20']} />
        </SkeletonCard>
      </div>
    )
  }

  return (
    <div className="page-enter space-y-6">
      <div className="flex items-center gap-3">
        <GitPullRequest className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">PR 列表</h1>
        {refreshing ? (
          <RefreshCw className="h-5 w-5 animate-spin text-brand-600 dark:text-brand-400" />
        ) : (
          <RefreshCw className="h-5 w-5 cursor-pointer text-brand-600 dark:text-brand-400" onClick={handleRefresh} />
        )}
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`chip${filter === key ? ' active' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-sm text-slate-500 dark:text-slate-400">
        共 {prs.length} 个 PR{error ? ` (${error})` : ''}
      </p>

      {filtered.length === 0 && !error ? (
        <div className="card flex items-center justify-center p-12 text-sm text-slate-400 dark:text-slate-500">
          暂无 PR 数据
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern">
              <thead>
                <tr>
                  <th>PR 编号</th>
                  <th>标题</th>
                  <th>作者</th>
                  <th>标签</th>
                  <th>模组</th>
                  <th>日期</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((pr) => (
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
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        {(pr.labels || []).map((l) => (
                          <span key={l.name} className="badge badge-gray">{l.name}</span>
                        ))}
                      </div>
                    </td>
                    <td className="text-slate-500 dark:text-slate-400">
                      {pr.modCount != null ? `${pr.modCount}` : '-'}
                    </td>
                    <td className="text-slate-500 dark:text-slate-400">
                      {fmtDate(pr.created_at || pr.createdDate)}
                    </td>
                    <td><StatusBadge status={prStatus(pr)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
