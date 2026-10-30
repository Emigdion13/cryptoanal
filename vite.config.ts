import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { kalshiPlugin } from './server/kalshi'
import { phonePlugin } from './server/phone'
import { workspacePlugin } from './server/workspace'

export default defineConfig({
  // The phone gate first: requests through Tailscale are checked before any other API sees them.
  plugins: [react(), phonePlugin(), workspacePlugin(), kalshiPlugin()],
  // A fixed port: another port is another origin, with none of the browser's saved state.
  // .ts.net: the iPhone page through Tailscale (server/phone.ts). It listens on localhost only;
  // `tailscale serve` on this computer is the way in.
  server: { port: 5190, strictPort: true, allowedHosts: ['.ts.net'] },
  preview: { port: 5190, strictPort: true, allowedHosts: ['.ts.net'] },
  build: {
    rollupOptions: {
      // phone.html: the iPhone page, built next to the app.
      input: { main: 'index.html', phone: 'phone.html' },
      output: {
        manualChunks(id) {
          if (id.includes('lightweight-charts') || id.includes('fancy-canvas')) return 'chart-engine'
          if (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return 'react'
        },
      },
    },
  },
})
