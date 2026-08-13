import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { ArrowLeft, GitCompare, FileText, ChevronDown } from 'lucide-react'
import { api, type CompareWorkspaceResponse, type WorkspaceCompareStatus } from '@/lib/api'
import { getErrorMessage } from '@/lib/helpers'
import { WorkspaceDiffTable } from './compare/WorkspaceDiffTable'

/** Shape returned by getCompareWorkspaces */
interface Workspace {
  slug: string
  version: string
  namespace: string
  files: string[]
}

const DEFAULT_FILTERS: WorkspaceCompareStatus[] = ['add', 'remove', 'modify']

export default function Compare() {
  const { prId } = useParams<{ prId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const prNumber = Number(prId)

  // Read slug/version/namespace from query params (W6)
  const slugParam = searchParams.get('slug') ?? undefined
  const versionParam = searchParams.get('version') ?? undefined
  const namespaceParam = searchParams.get('namespace') ?? undefined

  // Workspace list from PR
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [slugs, setSlugs] = useState<string[]>([])
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true)
  const [workspacesError, setWorkspacesError] = useState<string | null>(null)

  // Active selection
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  const [activeVersion, setActiveVersion] = useState<string | null>(null)
  const [activeNamespace, setActiveNamespace] = useState<string | null>(null)

  // Comparison result (per workspace)
  const [result, setResult] = useState<CompareWorkspaceResponse | null>(null)
  const [comparing, setComparing] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)

  // UI
  const [filters, setFilters] = useState<WorkspaceCompareStatus[]>(DEFAULT_FILTERS)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Load workspace list once per PR
  useEffect(() => {
    if (!prNumber || isNaN(prNumber)) {
      setWorkspacesError('无效的 PR 编号')
      setLoadingWorkspaces(false)
      return
    }

    let cancelled = false
    async function load() {
      setLoadingWorkspaces(true)
      setWorkspacesError(null)
      try {
        const data = await api.getCompareWorkspaces(prNumber)
        if (cancelled) return
        setWorkspaces(data.workspaces)
        setSlugs(data.slugs)
      } catch (err) {
        if (!cancelled) setWorkspacesError(getErrorMessage(err) || '加载工作区失败')
      } finally {
        if (!cancelled) setLoadingWorkspaces(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [prNumber])

  // Resolve (slug, version, namespace) from query params or fallback to first workspace
  useEffect(() => {
    if (workspaces.length === 0) return

    // 1. Resolve slug
    let targetSlug = slugParam ?? null
    if (targetSlug && !slugs.includes(targetSlug)) {
      targetSlug = slugs[0] ?? null
    }
    if (!targetSlug) {
      targetSlug = slugs[0] ?? null
    }
    setActiveSlug(targetSlug)

    if (!targetSlug) return

    // 2. Filter workspaces for this slug
    const slugWorkspaces = workspaces.filter((w) => w.slug === targetSlug)

    // 3. Resolve version/namespace
    let targetVersion = versionParam ?? null
    let targetNamespace = namespaceParam ?? null

    const exactMatch = slugWorkspaces.find(
      (w) => w.version === targetVersion && w.namespace === targetNamespace,
    )
    if (!exactMatch && slugWorkspaces.length > 0) {
      targetVersion = slugWorkspaces[0]!.version
      targetNamespace = slugWorkspaces[0]!.namespace
    }
    setActiveVersion(targetVersion)
    setActiveNamespace(targetNamespace)

    // 4. Sync URL if needed (only when query params differ from resolved)
    const needsSync =
      targetSlug !== slugParam || targetVersion !== versionParam || targetNamespace !== namespaceParam

    if (needsSync && targetSlug && targetVersion && targetNamespace) {
      const params = new URLSearchParams({ slug: targetSlug, version: targetVersion, namespace: targetNamespace })
      navigate(`/compare/${prNumber}?${params.toString()}`, { replace: true })
    }
  }, [workspaces, slugs, slugParam, versionParam, namespaceParam, prNumber, navigate])

  // Run compare for the active workspace
  // 请求序号保护:只接受最新一次请求的响应,组件卸载后同样忽略在途响应
  const compareReqId = useRef(0)

  useEffect(() => () => { compareReqId.current += 1 }, [])

  const runCompare = useCallback(async () => {
    if (!activeSlug || !activeVersion || !activeNamespace || !prNumber) return
    const reqId = ++compareReqId.current
    setComparing(true)
    setCompareError(null)
    try {
      const res = await api.compareWorkspace(prNumber, {
        slug: activeSlug,
        version: activeVersion,
        namespace: activeNamespace,
      })
      if (reqId !== compareReqId.current) return
      setResult(res)
    } catch (err) {
      if (reqId !== compareReqId.current) return
      // 失败时清空旧结果,避免错误横幅下残留上一个工作区的 diff(陈旧数据)
      setResult(null)
      setCompareError(getErrorMessage(err) || '比较失败')
    } finally {
      if (reqId === compareReqId.current) setComparing(false)
    }
  }, [activeSlug, activeVersion, activeNamespace, prNumber])

  // Auto-run when selection resolves
  useEffect(() => {
    runCompare()
  }, [runCompare])

  // Workspaces for the current slug (used in the dropdown)
  const slugWorkspaces = useMemo(
    () => workspaces.filter((w) => w.slug === activeSlug),
    [workspaces, activeSlug],
  )

  function onSelectWorkspace(w: Workspace) {
    setActiveSlug(w.slug)
    setActiveVersion(w.version)
    setActiveNamespace(w.namespace)
    setDropdownOpen(false)
    // Sync URL with query params (W6)
    const params = new URLSearchParams({ slug: w.slug, version: w.version, namespace: w.namespace })
    navigate(`/compare/${prNumber}?${params.toString()}`, { replace: true })
  }

  function onSelectSlug(s: string) {
    const first = workspaces.find((w) => w.slug === s)
    if (first) {
      onSelectWorkspace(first)
    }
  }

  // ---- Render ----

  if (loadingWorkspaces) {
    return (
      <div className="page-enter space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-64" />
          <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-96" />
          <div className="h-64 bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      </div>
    )
  }

  if (workspacesError) {
    return (
      <div className="page-enter space-y-6">
        <div className="card p-6 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
          <p className="text-red-600 dark:text-red-400">{workspacesError}</p>
        </div>
      </div>
    )
  }

  if (workspaces.length === 0) {
    return (
      <div className="page-enter space-y-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/pr/${prNumber}`)}
            className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <GitCompare className="h-6 w-6 text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            PR #{prNumber} 翻译比较
          </h1>
        </div>
        <div className="card p-6 text-sm text-slate-500 dark:text-slate-400">
          此 PR 没有检测到可比较的语言文件工作区。
        </div>
      </div>
    )
  }

  const activeLabel = activeSlug && activeVersion && activeNamespace
    ? `${activeSlug}  ${activeVersion} / ${activeNamespace}`
    : '选择工作区'

  return (
    <div className="page-enter space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/pr/${prNumber}`)}
            className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <GitCompare className="h-6 w-6 text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            PR #{prNumber} 翻译比较
          </h1>
          {activeSlug && (
            <span className="text-sm text-slate-500 dark:text-slate-400 ml-1">
              · {activeSlug}
            </span>
          )}
        </div>
        <Link
          to={`/special-diff/${prNumber}`}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        >
          <FileText className="h-3 w-3" />
          特殊文件对比
        </Link>
      </div>

      {/* Top bar: workspace dropdown */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Slug tabs / select */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-500 dark:text-slate-400 mr-1">Slug:</span>
            {slugs.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSelectSlug(s)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  s === activeSlug
                    ? 'bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Workspace dropdown (version / namespace) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setDropdownOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={dropdownOpen}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 min-w-[200px] justify-between"
            >
              <span className="truncate">{activeLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0" />
            </button>
            {dropdownOpen && (
              <div
                role="listbox"
                aria-label="选择工作区"
                aria-activedescendant={activeSlug && activeVersion && activeNamespace ? `ws-${activeSlug}-${activeVersion}-${activeNamespace}` : undefined}
                className="absolute right-0 z-20 mt-1 w-72 max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg"
              >
                {slugWorkspaces.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-slate-400">无可用工作区</div>
                ) : (
                  slugWorkspaces.map((w, i) => {
                    const selected = w.version === activeVersion && w.namespace === activeNamespace && w.slug === activeSlug
                    return (
                      <button
                        key={`${w.slug}-${w.version}-${w.namespace}-${i}`}
                        id={`ws-${w.slug}-${w.version}-${w.namespace}`}
                        role="option"
                        aria-selected={selected}
                        type="button"
                        onClick={() => onSelectWorkspace(w)}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 ${
                          selected ? 'bg-slate-100 dark:bg-slate-700 font-medium' : ''
                        }`}
                      >
                        <div className="text-slate-800 dark:text-slate-200">
                          {w.version} / {w.namespace}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {w.files.length} 个文件
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Result */}
      {comparing && (
        <div className="card p-6 text-sm text-slate-500 dark:text-slate-400">
          比较中...
        </div>
      )}

      {compareError && (
        <div className="card p-4 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 text-sm text-red-600 dark:text-red-400">
          {compareError}
        </div>
      )}

      {result && !comparing && (
        <WorkspaceDiffTable
          rows={result.rows}
          summary={result.summary}
          filters={filters}
          onFiltersChange={setFilters}
          missingFiles={result.meta.missingFiles}
        />
      )}
    </div>
  )
}
