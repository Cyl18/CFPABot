import { useEffect, lazy, Suspense, type ReactNode } from 'react'
import { Routes, Route, Outlet, Navigate, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary'
import Layout from '@/components/Layout'
import { useAuthStore } from '@/stores/authStore'
import Skeleton from '@/components/Skeleton'

// ---- Lazy-loaded pages (W9: React.lazy + global Suspense) ----
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const PrList = lazy(() => import('@/pages/PrList'))
const PrDetail = lazy(() => import('@/pages/PrDetail'))
const Compare = lazy(() => import('@/pages/Compare'))
const CompareIndex = lazy(() => import('@/pages/CompareIndex'))
const CrossVersion = lazy(() => import('@/pages/CrossVersion'))
const SpecialDiff = lazy(() => import('@/pages/SpecialDiff'))
const Sessions = lazy(() => import('@/pages/Sessions'))
const Logs = lazy(() => import('@/pages/Logs'))
const AdminPanel = lazy(() => import('@/pages/AdminPanel'))
const AdminLlmConfig = lazy(() => import('@/pages/admin/AdminLlmConfig'))
const AdminMock = lazy(() => import('@/pages/admin/AdminMock'))
const AdminUnmapped = lazy(() => import('@/pages/admin/AdminUnmapped'))
const NotFound = lazy(() => import('@/pages/NotFound'))

/** Guard component: renders children only for admin users. */
function RequireAdmin() {
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-slate-400 text-sm">
        加载中...
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/" state={{ from: location.pathname }} replace />
  }

  if (!user.isAdmin) {
    return <Navigate to="/" state={{ from: location.pathname }} replace />
  }

  return <Outlet />
}

/** Wrap each page with its own error boundary so one crash can't take down the app. */
function wrap(name: string, el: ReactNode) {
  return <RouteErrorBoundary key={name} pageName={name}>{el}</RouteErrorBoundary>
}

export default function App() {
  useEffect(() => {
    useAuthStore.getState().fetchMe()
  }, [])

  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<Layout />}>
          {/* Public routes */}
          <Route index element={wrap('仪表盘', (
            <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
              <Dashboard />
            </Suspense>
          ))} />
          <Route path="/prs" element={wrap('PR 列表', (
            <Suspense fallback={<Skeleton.Card><Skeleton.TableRows /></Skeleton.Card>}>
              <PrList />
            </Suspense>
          ))} />
          <Route path="/pr/:number" element={wrap('PR 详情', (
            <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
              <PrDetail />
            </Suspense>
          ))} />
          <Route path="/compare" element={wrap('比较工具', (
            <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
              <CompareIndex />
            </Suspense>
          ))} />
          {/* Cross-version consistency (independent page, not a Compare tab) */}
          <Route path="/compare/versions/:slug" element={wrap('跨版本一致性', (
            <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
              <CrossVersion />
            </Suspense>
          ))} />
          <Route path="/compare/versions/:slug/:namespace" element={wrap('跨版本一致性', (
            <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
              <CrossVersion />
            </Suspense>
          ))} />
          <Route path="/compare/:prId" element={wrap('翻译比较', (
            <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
              <Compare />
            </Suspense>
          ))} />
          <Route path="/special-diff/:prId" element={wrap('特殊文件对比', (
            <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
              <SpecialDiff />
            </Suspense>
          ))} />
          {/* Admin-only routes */}
          <Route element={<RequireAdmin />}>
            <Route path="/agent" element={wrap('Agent', (
              <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
                <Sessions />
              </Suspense>
            ))} />
            <Route path="/admin" element={wrap('管理', (
              <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
                <AdminPanel />
              </Suspense>
            ))} />
            <Route path="/admin/mock" element={wrap('Mock 工具', (
              <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
                <AdminMock />
              </Suspense>
            ))} />
            <Route path="/admin/unmapped" element={wrap('未映射 Slug', (
              <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
                <AdminUnmapped />
              </Suspense>
            ))} />
            <Route path="/admin/llm" element={wrap('LLM 配置', (
              <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
                <AdminLlmConfig />
              </Suspense>
            ))} />
            <Route path="/admin/logs" element={wrap('事件日志', (
              <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
                <Logs />
              </Suspense>
            ))} />
            {/* Bookmark compat redirects */}
            <Route path="/logs" element={<Navigate to="/admin/logs" replace />} />
          </Route>
        </Route>
        <Route path="*" element={wrap('未找到', (
          <Suspense fallback={<Skeleton.Card><Skeleton.Block className="h-64" /></Skeleton.Card>}>
            <NotFound />
          </Suspense>
        ))} />
      </Routes>
    </ErrorBoundary>
  )
}
