import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.trycloudflare.com'],
    proxy: {
      // CRUCIBLE_API_TARGET lets a second dev stack (e.g. an isolated verification
      // backend on another port) reuse this config; default behavior is unchanged.
      '/api': { target: process.env.CRUCIBLE_API_TARGET ?? 'http://localhost:3001', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'app',
    rollupOptions: {
      external: ['fs', 'path', 'url'],
      output: {
        manualChunks(id) {
          if (id.includes('react-syntax-highlighter') || id.includes('react-markdown')) return 'markdown'
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'vendor'
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['fs', 'path', 'url'],
  },
})
