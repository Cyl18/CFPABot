import { useState, useEffect, useCallback } from 'react'
import { Outlet, NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  GitPullRequest,
  Bot,
  Shield,
  Menu,
  X,
  LogOut,
  LogIn,
  Sun,
  Moon,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'

// ---- Page title mapping ----
const PAGE_TITLES: Record<string, string> = {
  '/': '仪表盘',
  '/prs': 'PR 审核',
  '/agent': 'Agent',
  '/admin': '管理',
  '/admin/mock': 'Mock 工具',
  '/admin/llm': 'LLM 配置',
  '/admin/logs': '事件日志',
}

function getPageTitle(pathname: string): string {
  // Exact match
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname]
  // PR detail
  const prDetail = pathname.match(/^\/pr\/(\d+)$/)
  if (prDetail) return `PR #${prDetail[1]} 详情`
  return '仪表盘'
}

// ---- Nav items ----
interface NavItem {
  path: string
  label: string
  icon: typeof LayoutDashboard
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '仪表盘', icon: LayoutDashboard },
  { path: '/prs', label: 'PR 审核', icon: GitPullRequest },
  { path: '/agent', label: 'Agent', icon: Bot, adminOnly: true },
  { path: '/admin', label: '管理', icon: Shield, adminOnly: true },
]


// ---- Theme hook ----
function useTheme() {
  const [dark, setDark] = useState<boolean>(() => {
    const stored = localStorage.getItem('cfpa-theme')
    if (stored === 'dark') return true
    if (stored === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('cfpa-theme', dark ? 'dark' : 'light')
  }, [dark])

  const toggleTheme = useCallback(() => setDark((d) => !d), [])

  return { dark, toggleTheme }
}

// ---- Avatar fallback: 2-letter initials from login ----
function avatarInitials(login: string | undefined): string {
  if (!login) return '??'
  return login.slice(0, 2).toUpperCase()
}

// ---- Logo SVG ----
function LogoSvg() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id="logo-grad" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#logo-grad)" />
      <path
        d="M8 12L16 8L24 12V20L16 24L8 20V12Z"
        stroke="white"
        strokeWidth="1.5"
        fill="none"
      />
      <path d="M16 16V8" stroke="white" strokeWidth="1.5" />
      <path d="M8 12L16 16L24 12" stroke="white" strokeWidth="1.5" />
    </svg>
  )
}

// ---- Layout component ----
export default function Layout() {
  const location = useLocation()
  const { dark, toggleTheme } = useTheme()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const user = useAuthStore((s) => s.user)
  const login = useAuthStore((s) => s.login)
  const logout = useAuthStore((s) => s.logout)

  const pageTitle = getPageTitle(location.pathname)

  // Close sidebar on nav (mobile only)
  const handleNavClick = useCallback(() => {
    setSidebarOpen(false)
  }, [])

  // Close sidebar on overlay click
  const handleOverlayClick = useCallback(() => {
    setSidebarOpen(false)
  }, [])

  return (
    <div className="flex min-h-screen">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={handleOverlayClick}
        />
      )}

      {/* ---- Sidebar ---- */}
      <aside
        className={`sidebar-collapsed fixed inset-y-0 left-0 z-50 flex flex-col bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700/50 transition-[width] duration-200 ease-in-out h-screen ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0`}
      >
        {/* Logo */}
        <div className="sidebar-logo">
          <span className="sidebar-icon-wrap">
            <LogoSvg />
          </span>
          <span className="sidebar-label whitespace-nowrap text-lg font-semibold text-slate-900 dark:text-slate-100 opacity-0 -translate-x-2 transition-all duration-200 delay-75">
            CFPABot
          </span>
          {/* Mobile close button */}
          <button
            className="ml-auto rounded-md p-1 hover:bg-slate-100 dark:hover:bg-slate-700 lg:hidden shrink-0"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5 text-slate-500" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden">
          {NAV_ITEMS.filter((item) => !item.adminOnly || user?.isAdmin).map((item, i) => {
            const Icon = item.icon
            // Insert divider after dashboard (index 0)
            const showDivider = i === 0
            // Insert group gap before compare (index 4 → shifted to 2 when admin items hidden)
            const showGap = i === 2

            return (
              <div key={item.path}>
                {showDivider && <div className="sidebar-divider" />}
                {showGap && <div className="h-3" />}
                <NavLink
                  to={item.path}
                  end={item.path === '/'}
                  onClick={handleNavClick}
                  className={({ isActive }) =>
                    `nav-item${isActive ? ' active' : ''}`
                  }
                >
                  <span className="sidebar-icon-wrap">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="sidebar-label whitespace-nowrap opacity-0 -translate-x-2 transition-all duration-200 delay-75">
                    {item.label}
                  </span>
                </NavLink>
              </div>
            )
          })}
        </nav>

        {/* User section */}
        <div className="sidebar-user">
          {user ? (
            <>
              <span className="sidebar-icon-wrap">
                {user.avatar ? (
                  <img
                    src={user.avatar}
                    alt={user.login}
                    className="w-8 h-8 rounded-lg object-cover"
                  />
                ) : (
                  <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold">
                    {avatarInitials(user.login)}
                  </span>
                )}
              </span>
              <div className="sidebar-label flex-1 min-w-0 opacity-0 -translate-x-2 transition-all duration-200 delay-75">
                <div className="whitespace-nowrap text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                  {user.login}
                </div>
              </div>
              <button
                onClick={logout}
                className="sidebar-label p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 opacity-0 -translate-x-2 transition-all duration-200 delay-75"
                title="退出登录"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button
              onClick={login}
              className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
            >
              <span className="sidebar-icon-wrap">
                <LogIn className="h-5 w-5" />
              </span>
              <span className="sidebar-label whitespace-nowrap opacity-0 -translate-x-2 transition-all duration-200 delay-75">
                登录
              </span>
            </button>
          )}
        </div>
      </aside>

      {/* ---- Main content ---- */}
      <div className="flex flex-1 flex-col min-w-0 lg:ml-[58px] lg:h-screen lg:overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-4 h-14 px-6 border-b border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800 shrink-0">
          <button
            aria-label="打开菜单"
            className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 lg:hidden"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <Menu className="h-5 w-5 text-slate-600 dark:text-slate-400" />
          </button>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 flex-1">
            {pageTitle}
          </h1>
          <button onClick={toggleTheme} className="theme-toggle" title="切换主题">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 p-6 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
