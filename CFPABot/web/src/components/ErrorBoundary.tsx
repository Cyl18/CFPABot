import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-900 p-6">
          <div className="card max-w-md w-full p-6 text-center">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
              页面出了点问题
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              {this.state.error?.message ?? '发生未预期的错误'}
            </p>
            <button
              className="btn btn-sm bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={() => window.location.reload()}
            >
              重新加载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
