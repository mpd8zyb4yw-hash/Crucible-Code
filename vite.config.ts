import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'app',
    rollupOptions: {
      external: ['fs', 'path', 'url'],
    },
  },
  optimizeDeps: {
    exclude: ['fs', 'path', 'url'],
  },
})
