import { useMemo } from 'react'
import type { CompareWorkspaceRow, WorkspaceCompareStatus, WorkspaceCompareSummary } from '@/lib/api'
import { StatBadge } from './StatBadge'
import { InlineModified } from './InlineTextDiff'

interface WorkspaceDiffTableProps {
  rows: CompareWorkspaceRow[]
  summary: WorkspaceCompareSummary
  filters: WorkspaceCompareStatus[]
  onFiltersChange: (next: WorkspaceCompareStatus[]) => void
  missingFiles?: string[]
}

const STATUSES: WorkspaceCompareStatus[] = ['add', 'remove', 'modify', 'unchanged']

const statusLabels: Record<WorkspaceCompareStatus, string> = {
  add: '新增',
  remove: '删除',
  modify: '修改',
  unchanged: '未变',
}

// Left border tinted by enStatus
const statusBorderL: Record<WorkspaceCompareStatus, string> = {
  add: 'border-l-green-500',
  remove: 'border-l-red-500',
  modify: 'border-l-amber-500',
  unchanged: 'border-l-slate-300 dark:border-l-slate-600',
}

// Right border tinted by zhStatus
const statusBorderR: Record<WorkspaceCompareStatus, string> = {
  add: 'border-r-green-500',
  remove: 'border-r-red-500',
  modify: 'border-r-amber-500',
  unchanged: 'border-r-slate-300 dark:border-r-slate-600',
}

const chipInactive =
  'bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'

const chipActive: Record<WorkspaceCompareStatus, string> = {
  add: 'bg-green-600 border border-green-600 text-white',
  remove: 'bg-red-600 border border-red-600 text-white',
  modify: 'bg-amber-600 border border-amber-600 text-white',
  unchanged: 'bg-slate-500 border border-slate-500 text-white',
}

const badgeColor: Record<WorkspaceCompareStatus, 'green' | 'red' | 'yellow' | 'slate'> = {
  add: 'green',
  remove: 'red',
  modify: 'yellow',
  unchanged: 'slate',
}

export function WorkspaceDiffTable({
  rows,
  summary,
  filters,
  onFiltersChange,
  missingFiles,
}: WorkspaceDiffTableProps) {
  const visibleRows = useMemo(() => {
    if (filters.length === 0) return rows
    return rows.filter((r) => filters.includes(r.enStatus) || filters.includes(r.zhStatus))
  }, [rows, filters])

  const toggleFilter = (status: WorkspaceCompareStatus) => {
    if (filters.includes(status)) {
      onFiltersChange(filters.filter((s) => s !== status))
    } else {
      onFiltersChange([...filters, status])
    }
  }

  return (
    <div className="space-y-4">
      {/* Missing files warning banner */}
      {missingFiles && missingFiles.length > 0 && (
        <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 rounded-lg px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200 break-words">
          <span className="font-medium">缺失文件: </span>
          {missingFiles.join(', ')}
        </div>
      )}

      {/* Summary badges */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">EN</div>
            <div className="flex flex-wrap gap-2">
              <StatBadge label="新增" value={summary.en.add} color={badgeColor.add} />
              <StatBadge label="删除" value={summary.en.remove} color={badgeColor.remove} />
              <StatBadge label="修改" value={summary.en.modify} color={badgeColor.modify} />
              <StatBadge label="未变" value={summary.en.unchanged} color={badgeColor.unchanged} />
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">ZH</div>
            <div className="flex flex-wrap gap-2">
              <StatBadge label="新增" value={summary.zh.add} color={badgeColor.add} />
              <StatBadge label="删除" value={summary.zh.remove} color={badgeColor.remove} />
              <StatBadge label="修改" value={summary.zh.modify} color={badgeColor.modify} />
              <StatBadge label="未变" value={summary.zh.unchanged} color={badgeColor.unchanged} />
            </div>
          </div>
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400 mr-1">筛选:</span>
        {STATUSES.map((s) => {
          const active = filters.includes(s)
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleFilter(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                active ? chipActive[s] : chipInactive
              }`}
            >
              {statusLabels[s]}
            </button>
          )
        })}
      </div>

      {/* Diff table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                <th className="px-4 py-2.5 text-left font-medium text-slate-600 dark:text-slate-400 w-[40px]">
                  #
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-slate-600 dark:text-slate-400">
                  Key
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-slate-600 dark:text-slate-400">
                  英文
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-slate-600 dark:text-slate-400">
                  中文
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visibleRows.map((row, idx) => (
                <tr
                  key={row.key}
                  className={`border-l-4 border-r-4 ${statusBorderL[row.enStatus]} ${statusBorderR[row.zhStatus]} hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors`}
                >
                  <td className="px-4 py-2 text-slate-400 dark:text-slate-500 text-xs">{idx + 1}</td>
                  <td className="px-4 py-2 font-mono text-xs max-w-[300px] truncate" title={row.key}>
                    {row.key}
                  </td>
                  <td className="px-4 py-2 max-w-[400px]">
                    {row.oldEnglish === row.newEnglish ? (
                      <span className="text-sm text-slate-700 dark:text-slate-300 break-words">
                        {row.newEnglish || '-'}
                      </span>
                    ) : (
                      <InlineModified oldValue={row.oldEnglish} newValue={row.newEnglish} />
                    )}
                  </td>
                  <td className="px-4 py-2 max-w-[400px]">
                    {row.oldChinese === row.newChinese ? (
                      <span className="text-sm text-slate-700 dark:text-slate-300 break-words">
                        {row.newChinese || '-'}
                      </span>
                    ) : (
                      <InlineModified oldValue={row.oldChinese} newValue={row.newChinese} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visibleRows.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            没有匹配的行
          </div>
        )}
      </div>
    </div>
  )
}
