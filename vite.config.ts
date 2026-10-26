import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5190 },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('lightweight-charts') || id.includes('fancy-canvas')) return 'chart-engine'
          if (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return 'react'
        },
      },
    },
  },
})
