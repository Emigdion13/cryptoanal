import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { workspacePlugin } from './server/workspace'

export default defineConfig({
  plugins: [react(), workspacePlugin()],
  // A fixed port: another port is another origin, with none of the browser's saved state.
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
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
