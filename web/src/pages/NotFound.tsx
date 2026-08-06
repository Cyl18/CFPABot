import { useNavigate } from 'react-router-dom'
import { Home } from 'lucide-react'

export default function NotFound() {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-900">
      <div className="card w-full max-w-sm p-8 text-center">
        <p className="bg-gradient-to-br from-indigo-500 to-purple-600 bg-clip-text text-7xl font-bold leading-none text-transparent">
          404
        </p>

        <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-slate-100">
          页面未找到
        </h1>

        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          你访问的页面不存在或已被移除
        </p>

        <button
          onClick={() => navigate('/')}
          className="btn btn-primary mt-6 w-full justify-center"
        >
          <Home className="h-4 w-4" />
          返回首页
        </button>
      </div>
    </div>
  )
}
