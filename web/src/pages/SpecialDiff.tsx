import { useEffect, useState, useCallback, lazy, Suspense, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
const DiffEditor = lazy(() => import('@monaco-editor/react').then(m => ({ default: m.DiffEditor })))
import { ArrowLeft, FileText } from 'lucide-react'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/helpers'

interface SpecialDiffFile {
  path: string
  status: string
  baseContent: string
  headContent: string
}

export default function SpecialDiff() {
  const { prId } = useParams<{ prId: string }>()
  const prNumber = Number(prId)

  const [files, setFiles] = useState<SpecialDiffFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [isDark, setIsDark] = useState(
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  )
  /** 请求序号:只接受最新一次请求的响应,组件卸载后同样忽略在途响应 */
  const loadReqId = useRef(0)

  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains("dark"))
    })
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  const compareTheme: 'vs-dark' | 'light' = isDark ? 'vs-dark' : 'light'

  const fetchData = useCallback(async () => {
    if (!prNumber || Number.isNaN(prNumber)) {
      setError('无效的 PR ID')
      setLoading(false)
      return
    }
    const reqId = ++loadReqId.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.getSpecialDiff(prNumber)
      if (reqId !== loadReqId.current) return
      setFiles(res.files)
      setActiveIndex(0)
    } catch (err) {
      if (reqId !== loadReqId.current) return
      setError(getErrorMessage(err) || '加载特殊文件失败')
    } finally {
      if (reqId === loadReqId.current) setLoading(false)
    }
  }, [prNumber])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const activeFile = files[activeIndex]

  if (loading) {
    return (
      <div className="page-enter space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-64" />
          <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-full" />
          <div className="h-64 bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="page-enter space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          to={`/compare/${prNumber}`}
          className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <FileText className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          PR #{prNumber} 特殊文件对比
        </h1>
      </div>

      {/* Error state */}
      {error && (
        <div className="card p-4 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
          <p className="text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Empty state */}
      {!error && files.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-slate-500 dark:text-slate-400">
            本次 PR 没有特殊文件（手册/文档）变更。
          </p>
        </div>
      )}

      {/* Diff editor */}
      {files.length > 0 && activeFile && (
        <>
          {/* File tabs */}
          <div className="flex flex-wrap gap-2">
            {files.map((file, idx) => (
              <button
                key={file.path}
                onClick={() => setActiveIndex(idx)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  idx === activeIndex
                    ? 'bg-brand-600 text-white dark:bg-brand-500'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                <span className="mr-1.5">{file.path.split('/').pop() ?? file.path}</span>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                  file.status === 'added'
                    ? 'bg-green-500'
                    : file.status === 'removed'
                    ? 'bg-red-500'
                    : file.status === 'modified'
                    ? 'bg-yellow-500'
                    : 'bg-slate-400'
                }`} />
              </button>
            ))}
          </div>

          {/* File path subtitle */}
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {activeFile.path}
            <span className="ml-2 capitalize">({activeFile.status})</span>
          </p>

          {/* Monaco DiffEditor */}
          <div className="rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
            <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-280px)] text-sm text-slate-500">加载编辑器...</div>}>
            <DiffEditor
              height="calc(100vh - 280px)"
              language="plaintext"
              original={activeFile.baseContent}
              modified={activeFile.headContent}
              theme={compareTheme}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                fontSize: 13,
              }}
            />
            </Suspense>
          </div>
        </>
      )}
    </div>
  )
}
