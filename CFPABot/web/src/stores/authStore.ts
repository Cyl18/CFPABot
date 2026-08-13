import { create } from 'zustand'
import { api } from '@/lib/api'

export interface User {
  login: string
  id: number
  email?: string
  avatar?: string
  isAdmin: boolean
  isContributor: boolean
}

interface AuthState {
  user: User | null
  isLoading: boolean
  error: string | null
  fetchMe: () => Promise<void>
  login: () => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  // 初始为 true:首帧先展示加载态,避免已登录管理员被 RequireAdmin 误判为未登录而重定向
  isLoading: true,
  error: null,

  fetchMe: async () => {
    set({ isLoading: true, error: null })
    try {
      const user = await api.getMe()
      set({ user, isLoading: false })
    } catch (e) {
      set({ user: null, isLoading: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  login: () => {
    window.location.href = '/api/oauth/github'
  },

  logout: async () => {
    try {
      await fetch('/api/oauth/signout', { credentials: 'include' })
    } catch { /* ignore */ }
    set({ user: null, error: null })
    window.location.href = '/'
  },
}))

export const isAuthenticated = (s: AuthState) => s.user !== null

export const isAdmin = (s: AuthState) => s.user?.isAdmin === true
