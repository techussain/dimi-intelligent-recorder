/**
 * Serves the built renderer (dist/) from `app://bundle/…` instead of file://.
 *
 * Why: response headers set via session.webRequest never reach pages loaded
 * from file://, so the production app ran without its Content-Security-Policy
 * and without COOP/COEP (no cross-origin isolation, so no SharedArrayBuffer).
 * A privileged custom scheme lets us attach those headers to every response
 * ourselves, and gives the app a real, stable origin.
 *
 * Only files inside dist/ are served; anything else is a 404.
 */
import * as fsp from 'fs/promises'
import * as path from 'path'
import { protocol } from 'electron'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** Must run before the app's 'ready' event. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true, // real origin: relative URLs, localStorage, IndexedDB, OPFS
        secure: true, // secure context (getDisplayMedia, WebCodecs, OPFS…)
        supportFetchAPI: true,
        stream: true, // media elements can stream / seek
        codeCache: true,
      },
    },
  ])
}

/**
 * Resolve a request URL to a file inside `distDir`, or null if the URL is
 * malformed, for another host, or escapes `distDir` (`..`, encoded slashes,
 * absolute paths). Exported for tests.
 */
export function resolveAppFile(rawUrl: string, distDir: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (rel.includes('\0') || rel.includes('\\')) return null
  if (rel === '/' || rel === '') rel = '/index.html'
  const root = path.resolve(distDir)
  const file = path.resolve(root, '.' + rel)
  if (file !== root && !file.startsWith(root + path.sep)) return null
  return file
}

/**
 * Serve `distDir` on app://bundle with `headers` on every response.
 * Call once, after 'ready'.
 */
export function handleAppScheme(
  distDir: string,
  headers: Record<string, string>,
): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(request.url, distDir)
    if (!file) return new Response('Bad request', { status: 400, headers })
    try {
      // fs reads inside app.asar transparently.
      const body = await fsp.readFile(file)
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { ...headers, 'Content-Type': type },
      })
    } catch {
      return new Response('Not found', { status: 404, headers })
    }
  })
}
