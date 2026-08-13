import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Force a single React copy. A stray pnpm install under web/ can leave a
    // second React and break hooks (Invalid hook call / useEffect of null).
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/github': { target: 'http://localhost:8080', changeOrigin: true },
      '/callback': { target: 'http://localhost:8080', changeOrigin: true },
      '/signout': { target: 'http://localhost:8080', changeOrigin: true },
      '/me': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
