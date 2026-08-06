import { Link } from "react-router-dom"

import { useState, useCallback, useEffect } from 'react'
import { SearchX, RotateCcw, FileSearch, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { api, type UnmappedSlugsResponse } from '@/lib/api'

export default function AdminUnmapped() {
  const [unmappedData, setUnmappedData] = useState<UnmappedSlugsResponse | null>(null)
  const [loadingUnmapped, setLoadingUnmapped] = useState(false)
  const [unmappedFilter, setUnmappedFilter] = useState('')

  const fetchUnmappedSlugs = useCallback(async () => {
    setLoadingUnmapped(true)
    try {
      const data = await api.getUnmappedSlugs()
      setUnmappedData(data)
    } catch {
      setUnmappedData(null)
    } finally {
      setLoadingUnmapped(false)
    }
  }, [])

  useEffect(() => {
    fetchUnmappedSlugs()
  }, [fetchUnmappedSlugs])

  const filteredSlugs = unmappedData?.slugs.filter(
    (s) => !unmappedFilter || s.slug.toLowerCase().includes(unmappedFilter.toLowerCase()),
  )

  return (
    <div className="page-enter space-y-6">
      {/* Back link */}
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
        <span aria-hidden="true">&larr;</span> 返回管理
      </Link>

      {/* Header */}
      <div className="flex items-center gap-3">
        <SearchX className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">未映射模组</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            CFPA 仓库中无 CurseForge 映射的 slug
          </p>
        </div>
      </div>

      {/* Summary bar */}
      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-700 dark:text-slate-300">
              <span className="font-semibold">{unmappedData?.total ?? '...'}</span>{' '}
              <span className="text-slate-500 dark:text-slate-400">个未映射模组</span>
            </span>
            <span className="hidden sm:inline text-slate-300 dark:text-slate-600">|</span>
            <span className="text-slate-500 dark:text-slate-400 text-xs">
              映射 {unmappedData?.mappedCount ?? '...'} / 共 {unmappedData?.totalModlistEntries ?? '...'} 个模组
              {unmappedData && unmappedData.lastScannedId > 0 && (
                <> · 已扫描至 ID {unmappedData.lastScannedId}</>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {unmappedData && unmappedData.total === 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                全部已映射
              </span>
            )}
            <button
              type="button"
              onClick={fetchUnmappedSlugs}
              disabled={loadingUnmapped}
              aria-label="刷新"
              className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-50 transition-colors"
            >
              <RotateCcw className={`h-3 w-3 ${loadingUnmapped ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>
        </div>
      </div>

      {/* Filter */}
      <div className="relative">
        <FileSearch className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="text"
          value={unmappedFilter}
          onChange={(e) => setUnmappedFilter(e.target.value)}
          placeholder="筛选 slug..."
          className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Slug list */}
      <div className="card p-4">
        {loadingUnmapped && !unmappedData ? (
          <div className="flex items-center justify-center py-12 text-slate-400">
            <RotateCcw className="h-5 w-5 animate-spin" />
          </div>
        ) : !unmappedData || unmappedData.error ? (
          <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 py-4">
            <AlertTriangle className="h-4 w-4" />
            {unmappedData?.error ?? '加载失败，请刷新重试'}
          </div>
        ) : filteredSlugs && filteredSlugs.length > 0 ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-700/50 max-h-[600px] overflow-y-auto">
            {filteredSlugs.map((s) => (
              <div key={s.slug} className="flex items-center justify-between py-2.5 px-1">
                <span className="text-sm font-mono text-slate-800 dark:text-slate-200">{s.slug}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {s.versions.join(', ')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
            <SearchX className="h-8 w-8 mb-2" />
            <p className="text-sm">{unmappedFilter ? '无匹配结果' : '全部模组均已映射'}</p>
          </div>
        )}
      </div>
    </div>
  )
}
