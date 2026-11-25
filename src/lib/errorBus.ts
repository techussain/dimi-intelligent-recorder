/**
 * Minimal global async error bus.
 *
 * Any async catch block that cannot surface an error through a direct
 * UI channel should call `emitError` instead of `console.error`. App.tsx
 * subscribes and forwards to the Toast system so the user always sees it.
 */

type ErrorListener = (message: string, detail: unknown) => void

const listeners = new Set<ErrorListener>()

export function onError(cb: ErrorListener): void {
  listeners.add(cb)
}

export function offError(cb: ErrorListener): void {
  listeners.delete(cb)
}

/** Readable text for any thrown value (Error stack, string, JSON-able, …). */
export function describeDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return ''
  if (detail instanceof Error)
    return detail.stack ?? `${detail.name}: ${detail.message}`
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return Object.prototype.toString.call(detail)
  }
}

/** Write an error to the desktop app's local log file (no-op in the browser). */
export function logToFile(message: string, detail?: unknown): void {
  try {
    window.electronAPI?.diagnostics.logError(message, describeDetail(detail))
  } catch {
    // Logging must never throw.
  }
}

let globalHandlersInstalled = false

/**
 * Log uncaught errors and unhandled promise rejections to the local log file,
 * so failures users hit in the field can be diagnosed from Help > Open Logs
 * Folder. Idempotent.
 */
export function installGlobalErrorLogging(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') return
  globalHandlersInstalled = true
  window.addEventListener('error', (ev) => {
    logToFile(`Uncaught: ${ev.message}`, ev.error ?? `${ev.filename}:${ev.lineno}`)
  })
  window.addEventListener('unhandledrejection', (ev) => {
    logToFile('Unhandled promise rejection', ev.reason)
  })
}

export function emitError(message: string, detail?: unknown): void {
  // Always keep a console trace for debugging, and a line in the log file.
  console.error('[errorBus]', message, detail)
  logToFile(message, detail)
  for (const cb of listeners) {
    try {
      cb(message, detail)
    } catch {
      // Listeners must not throw — swallow silently.
    }
  }
}
