import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// COOP/COEP make the page cross-origin isolated, unlocking SharedArrayBuffer
// and high-resolution timers for the OPFS writer worker and WebCodecs export.
// The Electron shell sets the same headers in electron/main.cts.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
  configurePreviewServer(server: import('vite').PreviewServer) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), crossOriginIsolation],
  worker: { format: 'es' },
  build: { sourcemap: 'hidden' },
})
