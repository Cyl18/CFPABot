import { Link } from "react-router-dom"

import { Play, AlertTriangle } from 'lucide-react'
import AdminWebhook from './AdminWebhook'
import AdminMockConfig from './AdminMockConfig'
import AdminOutbound from './AdminOutbound'

export default function AdminMock() {
  return (
    <div className="page-enter space-y-6">
      {/* Back link */}
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
        <span aria-hidden="true">&larr;</span> 返回管理
      </Link>

      {/* Header */}
      <div className="flex items-center gap-3">
        <Play className="h-6 w-6 text-brand-600 dark:text-brand-400" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Mock 工具</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            模拟 webhook、查看 outbound 调用
          </p>
        </div>
      </div>

      {/* Quick info banner */}
      <div className="card p-4 bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/30">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-700 dark:text-amber-300">
            <p className="font-medium">Mock 模式工作原理</p>
            <ul className="list-disc list-inside mt-1 space-y-0.5 text-xs">
              <li>触发 mock webhook 时，后端使用 <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">MockGitHubClient</code> 替代真实 GitHub API</li>
              <li>所有 GitHub API 出站调用都会被捕获，不会到达 GitHub</li>
              <li>PR 详情页 (<code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">/pr/:id</code>) 仍直接调用 GitHub API — mock 写入的数据不会被该页消费的</li>
              <li>需要在 <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">ASPNETCORE_ENVIRONMENT=Development</code> 下使用</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Webhook section */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Webhook 模拟</h2>
        <AdminWebhook />
      </section>

      {/* Mock config section */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Mock 配置</h2>
        <AdminMockConfig />
      </section>

      {/* Outbound section */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Outbound / 捕获调用</h2>
        <AdminOutbound />
      </section>
    </div>
  )
}
