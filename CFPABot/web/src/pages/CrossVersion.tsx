import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Loader2, AlertTriangle } from 'lucide-react'
import {
  api,
  type CrossVersionResponse,
  type CrossVersionRow,
} from '@/lib/api'
import { getErrorMessage } from '@/lib/helpers'

type InconsistencyFilter = 'enDiffers' | 'zhDiffers' | 'enSameZhDiffers'

const CONSISTENT_BADGE = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'
const INCONSISTENT_BADGE = 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300'

function cellBg(cell: { enPresent: boolean; zhPresent: boolean }): string {
  if (!cell.enPresent && !cell.zhPresent) return 'bg-slate-50 dark:bg-slate-900/30'
  if (!cell.enPresent || !cell.zhPresent) return 'bg-amber-50/50 dark:bg-amber-950/20'
  return ''
}

function cellText(value: string, present: boolean): string {
  if (!present) return '—'
  return value || '(空)'
}

export default function CrossVersion() {
  const { slug, namespace: nsParam } = useParams<{ slug: string; namespace?: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const namespace = nsParam || (searchParams.get('namespace') ?? slug ?? '')
  const prIdParam = searchParams.get('pr')
  const prId = prIdParam ? Number(prIdParam) : undefined

  const [data, setData] = useState<CrossVersionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inconsistencyFilter, setInconsistencyFilter] = useState<InconsistencyFilter | null>(null)
  const [search, setSearch] = useState('')

  // 请求序号保护:只接受最新一次请求的响应,组件卸载后同样忽略在途响应
  const loadReqId = useRef(0)

  const load = useCallback(async () => {
    if (!slug) return
    const reqId = ++loadReqId.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.getCrossVersion(slug, namespace, prId)
      if (reqId !== loadReqId.current) return
      setData(res)
    } catch (err) {
      if (reqId !== loadReqId.current) return
      setError(getErrorMessage(err) || '加载失败')
    } finally {
      if (reqId === loadReqId.current) setLoading(false)
    }
  }, [slug, namespace, prId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => () => { loadReqId.current += 1 }, [])

  const filteredRows = useMemo(() => {
    if (!data) return []
    let rows = data.rows
    if (inconsistencyFilter === 'enDiffers') rows = rows.filter((r) => !r.enConsistent)
    else if (inconsistencyFilter === 'zhDiffers') rows = rows.filter((r) => !r.zhConsistent)
    else if (inconsistencyFilter === 'enSameZhDiffers') rows = rows.filter((r) => r.enSameZhDiffers)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter((r) => r.key.toLowerCase().includes(q))
    }
    return rows
  }, [data, inconsistencyFilter, search])

  if (loading) {
    return (
      <div className="page-enter space-y-6">
        <Link to="/prs" className="btn btn-ghost btn-sm">
          <ArrowLeft className="h-4 w-4" /> 返回列表
        </Link>
        <div className="flex items-center justify-center p-12 gap-3 text-sm text-slate-500 dark:text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" /> 加载中…
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="page-enter space-y-6">
        <Link to="/prs" className="btn btn-ghost btn-sm">
          <ArrowLeft className="h-4 w-4" /> 返回列表
        </Link>
        <div className="card flex items-center justify-center p-12 text-sm text-rose-500">
          {error || '加载失败'}
        </div>
      </div>
    )
  }

  if (data.versions.length === 0) {
    return (
      <div className="page-enter space-y-6">
        <Link to="/prs" className="btn btn-ghost btn-sm">
          <ArrowLeft className="h-4 w-4" /> 返回列表
        </Link>
        <div className="card flex items-center justify-center p-12 text-sm text-slate-400">
          该 slug 在 main 分支下未找到任何版本的语言文件。
        </div>
      </div>
    )
  }

  return (
    <div className="page-enter space-y-6">
      <button onClick={() => navigate(-1)} className="btn btn-ghost btn-sm">
        <ArrowLeft className="h-4 w-4" /> 返回
      </button>

      <div className="card p-6">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
          跨版本一致性 · {data.slug}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          namespace: {data.namespace} · {data.versions.length} 个版本 · {data.summary.totalKeys} 个 key
        </p>
        {prId !== undefined && (
          <p className="text-xs text-slate-400 mt-1">
            已按 PR #{prId} 触及的 key 过滤
            {data.prFiltered === false ? '（过滤失败，展示全量）' : ''}
          </p>
        )}
        {data.summary.enSameZhDiffersKeys > 0 && (
          <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 text-xs border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" />
            {data.summary.enSameZhDiffersKeys} 个 key EN 一致但 ZH 不一致（强信号）
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="card p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <div>
          <div className="text-xs text-slate-500 mb-1">Key 总数</div>
          <div className="text-lg font-semibold text-slate-800 dark:text-slate-200">
            {data.summary.totalKeys}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">EN 一致</div>
          <div className="text-lg font-semibold text-emerald-600">{data.summary.enConsistentKeys}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">ZH 一致</div>
          <div className="text-lg font-semibold text-emerald-600">{data.summary.zhConsistentKeys}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">EN 同 ZH 异</div>
          <div className="text-lg font-semibold text-amber-600">{data.summary.enSameZhDiffersKeys}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 key…"
          className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
        />
        <span className="text-xs text-slate-500 ml-2">高亮:</span>
        {(
          [
            ['enDiffers', 'EN 不一致'],
            ['zhDiffers', 'ZH 不一致'],
            ['enSameZhDiffers', 'EN 同 ZH 异'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() =>
              setInconsistencyFilter((cur) => (cur === k ? null : (k as InconsistencyFilter)))
            }
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              inconsistencyFilter === k
                ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700'
                : 'bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Matrix */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="跨版本一致性矩阵">
            <caption className="sr-only">跨版本一致性矩阵表 — 每行一个 key，每列一个版本</caption>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400 w-[40px]">#</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400 min-w-[200px]">Key</th>
                {data.versions.map((v) => (
                  <th
                    key={v}
                    className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400 min-w-[220px]"
                  >
                    <div className="text-xs uppercase tracking-wide">{v}</div>
                    <div className="flex gap-2 mt-0.5">
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400">EN</span>
                      <span className="text-[10px] text-sky-600 dark:text-sky-400">ZH</span>
                    </div>
                  </th>
                ))}
                <th className="px-3 py-2 text-center font-medium text-slate-600 dark:text-slate-400 w-[100px]">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredRows.map((row, idx) => (
                <CrossVersionRowRow key={row.key} row={row} index={idx} versions={data.versions} />
              ))}
            </tbody>
          </table>
        </div>
        {filteredRows.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-400">无匹配的行</div>
        )}
      </div>
    </div>
  )
}

function CrossVersionRowRow({
  row,
  index,
  versions,
}: {
  row: CrossVersionRow
  index: number
  versions: string[]
}) {
  return (
    <tr>
      <td className="px-3 py-2 text-slate-400 dark:text-slate-500 text-xs">{index + 1}</td>
      <td className="px-3 py-2 font-mono text-xs max-w-[300px] truncate" title={row.key}>
        {row.key}
      </td>
      {versions.map((v) => {
        const cell = row.versions[v]
        if (!cell) return <td key={v} className="px-3 py-2 text-slate-300">—</td>
        return (
          <td key={v} className={`px-3 py-2 ${cellBg(cell)}`}>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-slate-700 dark:text-slate-300 break-words">
                {cellText(cell.en, cell.enPresent)}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400 break-words">
                {cellText(cell.zh, cell.zhPresent)}
              </span>
            </div>
          </td>
        )
      })}
      <td className="px-3 py-2 text-center">
        {row.enConsistent && row.zhConsistent ? (
          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${CONSISTENT_BADGE}`}>
            一致
          </span>
        ) : (
          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${INCONSISTENT_BADGE}`}>
            不一致
          </span>
        )}
      </td>
    </tr>
  )
}
