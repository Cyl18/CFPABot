import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, GitCompare, ExternalLink, FileText,
  Loader2, PlayCircle, ChevronDown, ChevronUp, Layers,
} from 'lucide-react'
import { api, type PrDetail as PrDetailType } from '@/lib/api'
import { getErrorMessage, StatusBadge } from '@/lib/helpers'
import { useAuthStore } from '@/stores/authStore'
import {
  parseProjectPath, buildWorkspaceLink, statusBadge,
  isLangFilePath, INITIAL_VISIBLE,
} from './pr-detail/file-list'

function WorkflowBadge({ conclusion }: { conclusion: string | null }) {
  if (!conclusion) return <span className="badge badge-gray"><span className="badge-dot" />运行中</span>
  switch (conclusion) {
    case 'success':
      return <span className="badge badge-green"><span className="badge-dot" />成功</span>
    case 'failure':
      return <span className="badge badge-red"><span className="badge-dot" />失败</span>
    case 'neutral':
      return <span className="badge badge-gray"><span className="badge-dot" />中立</span>
    case 'cancelled':
      return <span className="badge badge-gray"><span className="badge-dot" />已取消</span>
    case 'skipped':
      return <span className="badge badge-gray"><span className="badge-dot" />已跳过</span>
    case 'timed_out':
      return <span className="badge badge-red"><span className="badge-dot" />超时</span>
    case 'action_required':
      return <span className="badge badge-amber"><span className="badge-dot" />需操作</span>
    default:
      return <span className="badge badge-gray"><span className="badge-dot" />{conclusion}</span>
  }
}

interface FileListRow {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}
function FileList({ files, prId }: { files: FileListRow[]; prId: number }) {
  const [expanded, setExpanded] = useState(false);

  if (files.length === 0) {
    return (
      <p className="text-sm text-slate-400 dark:text-slate-500">此 PR 没有变更文件。</p>
    );
  }

  const visible = expanded ? files : files.slice(0, INITIAL_VISIBLE);
  const hiddenCount = files.length - INITIAL_VISIBLE;
  const hasMore = hiddenCount > 0;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="table-modern">
          <thead>
            <tr>
              <th className="min-w-[260px]">路径</th>
              <th>状态</th>
              <th className="w-20 text-right">+/-</th>
              <th className="w-24 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => {
              const parsed = parseProjectPath(f.path);
              const link = parsed ? buildWorkspaceLink(prId, parsed) : null;
              const badge = statusBadge(f.status);
              return (
                <tr key={f.path} className="group/file">
                  <td
                    className="font-mono text-xs text-slate-700 dark:text-slate-300 align-middle truncate"
                    title={f.path}
                  >
                    {f.path}
                  </td>
                  <td className="align-middle">
                    <span className={`badge ${badge.className}`}>
                      <span className="badge-dot" />
                      {badge.label}
                    </span>
                  </td>
                  <td className="align-middle text-right text-xs font-mono">
                    {f.additions > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400 mr-2">
                        +{f.additions}
                      </span>
                    )}
                    {f.deletions > 0 && (
                      <span className="text-rose-600 dark:text-rose-400">
                        −{f.deletions}
                      </span>
                    )}
                    {f.additions === 0 && f.deletions === 0 && (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="align-middle text-right">
                    {link ? (
                      <Link
                        to={link}
                        className="inline-flex items-center gap-1 text-xs text-brand-600 dark:text-brand-400 hover:underline opacity-0 group-hover/file:opacity-100 transition-opacity"
                      >
                        <GitCompare className="h-3.5 w-3.5" />
                        工作区
                      </Link>
                    ) : isLangFilePath(f.path) ? (
                      <span className="text-xs text-slate-400" title="无法解析工作区">—</span>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 mt-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls="file-list-body"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                收起
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                显示更多（剩余 {hiddenCount} 个文件）
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}


export default function PrDetail() {
  const { number } = useParams<{ number: string }>()
  const navigate = useNavigate()
  const prNumber = Number(number)
  const user = useAuthStore((s) => s.user)
  const [pr, setPr] = useState<PrDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Cross-version: unique slugs from PR changed lang files
  const [cvSlugs, setCvSlugs] = useState<string[]>([])
  const [creatingSession, setCreatingSession] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  useEffect(() => {
    if (!prNumber || isNaN(prNumber)) {
      setError('无效的 PR 编号')
      setLoading(false)
      return
    }

    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await api.getPr(prNumber)
        if (!cancelled) setPr(data)
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err) || '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [prNumber])
  // Cross-version slugs — independent of PR detail load (best-effort).
  useEffect(() => {
    if (!prNumber || isNaN(prNumber)) return
    let cancelled = false
    api.getCompareWorkspaces(prNumber)
      .then((res) => {
        if (!cancelled) setCvSlugs(res.slugs ?? [])
      })
      .catch(() => {
        // Best-effort: silently ignore.
      })
    return () => { cancelled = true }
  }, [prNumber])

  const handleStartReview = useCallback(async () => {
    if (!pr) return
    setCreatingSession(true)
    setSessionError(null)
    try {
      const result = await api.createSession({
        message: `开始审查 PR #${pr.prNumber}`,
        prNumber: pr.prNumber,
      })
      navigate(`/agent?session=${result.sessionId}`)
    } catch (err) {
      setSessionError(getErrorMessage(err) || '创建会话失败')
    } finally {
      setCreatingSession(false)
    }
  }, [pr, navigate])

  if (loading) {
    return (
      <div className="page-enter space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-64" />
          <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-96" />
          <div className="h-32 bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      </div>
    )
  }

  if (error || !pr) {
    return (
      <div className="page-enter space-y-6">
        <button onClick={() => navigate('/prs')} className="btn btn-ghost btn-sm">
          <ArrowLeft className="h-4 w-4" /> 返回列表
        </button>
        <div className="card flex items-center justify-center p-12 text-sm text-slate-400 dark:text-slate-500">
          {error || 'PR 数据不可用'}
        </div>
      </div>
    )
  }

  const hasSpecialFiles = (pr.files ?? []).some((f) => !isLangFilePath(f.path))

  return (
    <div className="page-enter space-y-6">
      <button onClick={() => navigate('/prs')} className="btn btn-ghost btn-sm">
        <ArrowLeft className="h-4 w-4" /> 返回列表
      </button>

      {/* Header */}
      <div className="card p-6">
        <div className="flex items-start gap-4 mb-6">
          <span className="font-mono text-2xl font-bold text-brand-600 dark:text-brand-400">
            #{pr.prNumber}
          </span>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
              {pr.title}
              {pr.draft && (
                <span className="ml-2 badge badge-gray">Draft</span>
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                作者: <strong className="text-slate-700 dark:text-slate-300">
                  {pr.author?.login ?? '未知'}
                </strong>
              </span>
              <StatusBadge status={pr.state === 'open' ? 'open' : 'closed'} />
            </div>
            {/* Labels */}
            {pr.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {pr.labels.map((l) => (
                  <span key={l} className="badge badge-gray">{l}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
          <Link
            to={`/compare/${pr.prNumber}`}
            className="btn btn-ghost btn-sm gap-1.5"
          >
            <GitCompare className="h-4 w-4" />
            翻译比较
          </Link>
          {hasSpecialFiles && (
            <Link
              to={`/special-diff/${pr.prNumber}`}
              className="btn btn-ghost btn-sm gap-1.5"
            >
              <FileText className="h-4 w-4" />
              特殊文件对比
            </Link>
          )}
          {cvSlugs.length > 0 && (
            <Link
              to={`/compare/versions/${cvSlugs[0]}?pr=${pr.prNumber}`}
              className="btn btn-ghost btn-sm gap-1.5"
              title="跨版本一致性（所有 version 的 en/zh 矩阵）"
            >
              <Layers className="h-4 w-4" />
              跨版本一致性
            </Link>
          )}


          <a
            href={pr.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost btn-sm gap-1.5"
          >
            <ExternalLink className="h-4 w-4" />
            在 GitHub 查看
          </a>

          {/* Review actions — admin only */}
          {user?.isAdmin && (
            <div className="ml-auto flex items-center gap-2">
              {sessionError && (
                <span className="text-xs text-rose-600 dark:text-rose-400">{sessionError}</span>
              )}

              <button
                onClick={handleStartReview}
                disabled={creatingSession}
                className="btn btn-primary btn-sm gap-1.5"
              >
                {creatingSession ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PlayCircle className="h-4 w-4" />
                )}
                开始审查
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Workflows */}
      {pr.workflows.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-6 pb-0">
            <div className="flex items-center gap-3 mb-4">
              <FileText className="h-5 w-5 text-brand-600 dark:text-brand-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                工作流
              </h2>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="table-modern">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {pr.workflows.map((w, i) => (
                  <tr key={w.name}>
                    <td className="font-medium text-slate-700 dark:text-slate-300">{w.name}</td>
                    <td><WorkflowBadge conclusion={w.conclusion} /></td>
                    <td>
                      {w.htmlUrl ? (
                        <a
                          href={w.htmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 dark:text-brand-400 hover:underline text-sm"
                        >
                          查看
                        </a>
                      ) : (
                        <span className="text-slate-400 text-sm">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Files list */}
      <div className="card overflow-hidden">
        <div className="p-6 pb-0">
          <div className="flex items-center gap-3 mb-4">
            <FileText className="h-5 w-5 text-brand-600 dark:text-brand-400" />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              文件变更
            </h2>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {pr.changedFiles} 个文件
            </span>
          </div>
        </div>
        <div className="p-2 pt-0">
          <FileList files={pr.files ?? []} prId={pr.prNumber} />
        </div>
      </div>
    </div>
  )
}
