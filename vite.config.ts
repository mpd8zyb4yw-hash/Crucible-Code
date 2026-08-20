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
  /**
   * The same proxy for `vite preview`.
   *
   * Dev mode serves unbundled modules, so a timing taken against it measures
   * the module graph as much as the app. Preview serves the real build, and
   * without this it served it with no backend at all — which made the only
   * production-shaped measurement available locally impossible to take.
   */
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.CRUCIBLE_API_TARGET ?? 'http://localhost:3001', changeOrigin: true, ws: true },
    },
  },
})
