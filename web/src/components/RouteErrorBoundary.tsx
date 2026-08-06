import { Component, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

interface Props {
  children: ReactNode
  /** Optional page name shown in the error message for context. */
  pageName?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Per-route error boundary. Isolates a single page crash so the rest of the
 * app (sidebar, other routes) stays usable. User can navigate home or retry
 * without a full reload — preserving the(root-level) ErrorBoundary as a last resort.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[RouteErrorBoundary]', this.props.pageName ?? 'page', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return <RouteErrorFallback pageName={this.props.pageName} onRetry={() => this.setState({ hasError: false, error: null })} />
    }
    return this.props.children
  }
}

function RouteErrorFallback({ pageName, onRetry }: { pageName?: string; onRetry: () => void }) {
  const navigate = useNavigate()
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="card max-w-md w-full p-6 text-center">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
          此页面出错
          {pageName ? ` (${pageName})` : ''}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          此区域发生未预期的错误，不影响其他功能。
        </p>
        <div className="flex justify-center gap-3">
          <button
            className="btn btn-sm bg-indigo-600 text-white hover:bg-indigo-700"
            onClick={onRetry}
          >
            重试
          </button>
          <button
            className="btn btn-sm bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600"
            onClick={() => navigate('/', { replace: true })}
          >
            返回首页
          </button>
        </div>
      </div>
    </div>
  )
}
