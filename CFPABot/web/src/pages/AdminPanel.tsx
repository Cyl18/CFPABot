import { useNavigate } from 'react-router-dom'
import { Shield, Play, Cpu, Database, ScrollText, SearchX, Activity } from 'lucide-react'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

const ADMIN_CARDS = [
  { path: '/admin/mock', icon: Play, label: 'Mock 工具', desc: '模拟 webhook、查看 outbound 调用' },
  { path: '/admin/llm', icon: Cpu, label: 'LLM 配置', desc: '模型端点管理与 models.dev 自动补全' },
  { path: '/admin/unmapped', icon: SearchX, label: '未映射模组', desc: 'CFPA 仓库中无 CurseForge 映射的 slug' },
  { path: '/admin/logs', icon: ScrollText, label: '事件日志', desc: '浏览应用日志与事件记录' },
]
export default function AdminPanel() {
  const navigate = useNavigate()
  const [rateLimit, setRateLimit] = useState<{ remaining: number; limit: number } | null>(null)

  useEffect(() => {
    api.getRateLimit()
      .then((data) => setRateLimit({ remaining: data.rate.remaining, limit: data.rate.limit }))
      .catch(() => {
        // Dev-only endpoint may 403; fail silently
      })
  }, [])

  return (
    <div className="page-enter space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">管理</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            选择工具进入管理页面
          </p>
        </div>
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {ADMIN_CARDS.map((card) => {
          const Icon = card.icon
          return (
            <button
              key={card.path}
              onClick={() => navigate(card.path)}
              className="card p-6 text-left hover:shadow-md transition-all hover:border-brand-300 dark:hover:border-brand-700 group"
            >
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-xl bg-brand-50 dark:bg-brand-950/30 text-brand-600 dark:text-brand-400 group-hover:bg-brand-100 dark:group-hover:bg-brand-900/40 transition-colors">
                  <Icon className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{card.label}</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{card.desc}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Rate limit badge */}
      {rateLimit && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800 px-4 py-3">
          <Activity className="h-4 w-4 text-slate-400" />
          <span className="text-sm text-slate-600 dark:text-slate-400">
            GitHub API 配额: <span className="font-semibold text-slate-800 dark:text-slate-200">{rateLimit.remaining}</span> / {rateLimit.limit}
            <span className="text-xs text-slate-400 ml-1">剩余</span>
          </span>
        </div>
      )}
    </div>
  )
}
