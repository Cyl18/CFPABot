import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitCompare, ArrowRight } from 'lucide-react'

export default function CompareIndex() {
  const navigate = useNavigate()
  const [prNumber, setPrNumber] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleOpen() {
    const num = Number(prNumber)
    if (!prNumber.trim()) {
      setError('请输入 PR 编号')
      return
    }
    if (!Number.isInteger(num) || num <= 0) {
      setError('请输入有效的正整数 PR 编号')
      return
    }
    setError(null)
    navigate(`/compare/${num}`)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleOpen()
  }

  return (
    <div className="page-enter space-y-6">
      <div className="flex items-center gap-3">
        <GitCompare className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          比较工具
        </h1>
      </div>

      <div className="card p-6 space-y-4">
        <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
          对比指定 PR 中英文翻译文件的差异，查看新增、修改、删除的内容，帮助快速定位翻译变更。
        </p>

        <div className="space-y-2">
          <label htmlFor="pr-input" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            PR 编号
          </label>
          <div className="flex gap-3">
            <input
              id="pr-input"
              type="number"
              min="1"
              step="1"
              value={prNumber}
              onChange={(e) => { setPrNumber(e.target.value); setError(null) }}
              onKeyDown={handleKeyDown}
              placeholder="例如 42"
              className="flex-1 max-w-xs px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-colors"
            />
            <button
              onClick={handleOpen}
              className="btn-primary px-4 py-2 text-sm font-medium rounded-lg inline-flex items-center gap-1.5"
            >
              打开比较
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>
      </div>
    </div>
  )
}
