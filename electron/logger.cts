/**
 * Local diagnostics: a tiny rotating file logger plus Electron's crash
 * reporter (minidumps kept on disk, never uploaded).
 *
 *   <logs>/main.log, main.1.log, main.2.log   (rotated at ~5 MB)
 *   <logs>/crashes/                           (Crashpad minidumps)
 *
 * <logs> is app.getPath('logs'):
 *   Windows  %APPDATA%\Dimi Intelligent Recorder\logs
 *   macOS    ~/Library/Logs/Dimi Intelligent Recorder
 *   Linux    ~/.config/Dimi Intelligent Recorder/logs
 *
 * Logging never throws: a failing disk only loses log lines.
 */
import { app, crashReporter, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

const MAX_BYTES = 5 * 1024 * 1024
/** Total files kept, including the live main.log. */
const KEEP = 3
const MAX_MESSAGE = 2000
const MAX_DETAIL = 8000

export type LogLevel = 'info' | 'warn' | 'error'

let logDir: string | null = null
let logFile: string | null = null
let logSize = 0

function ensureLogFile(): string | null {
  if (logFile) return logFile
  try {
    logDir = app.getPath('logs')
    fs.mkdirSync(logDir, { recursive: true })
    logFile = path.join(logDir, 'main.log')
    try {
      logSize = fs.statSync(logFile).size
    } catch {
      logSize = 0
    }
    return logFile
  } catch {
    return null
  }
}

function rotate(file: string) {
  const dir = path.dirname(file)
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? file : path.join(dir, `main.${i - 1}.log`)
    const to = path.join(dir, `main.${i}.log`)
    try {
      fs.renameSync(from, to)
    } catch {
      // missing generation — fine
    }
  }
  logSize = 0
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  try {
    return typeof err === 'string' ? err : JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Hook for remote crash/error reporting (e.g. Sentry). Deliberately a no-op:
 * the app ships without any telemetry. To enable it, initialise your SDK in
 * `initDiagnostics()` and forward the event here.
 */
function reportRemote(_level: LogLevel, _message: string, _detail?: string): void {
  // intentionally empty
}

/** Append one line (plus optional indented detail) to main.log. */
export function log(level: LogLevel, scope: string, message: string, detail?: unknown) {
  const msg = truncate(message, MAX_MESSAGE)
  const det =
    detail === undefined ? undefined : truncate(describeError(detail), MAX_DETAIL)
  const consoleFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (det) consoleFn(`[${scope}] ${msg}\n${det}`)
  else consoleFn(`[${scope}] ${msg}`)

  if (level !== 'info') reportRemote(level, `[${scope}] ${msg}`, det)

  const file = ensureLogFile()
  if (!file) return
  try {
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}\n`
    if (det) line += det.replace(/^/gm, '    ') + '\n'
    if (logSize + line.length > MAX_BYTES) rotate(file)
    fs.appendFileSync(file, line)
    logSize += Buffer.byteLength(line)
  } catch {
    // disk full / permission — drop the line
  }
}

/** Renderer-reported error (already sender-checked by main). */
export function logRendererError(message: unknown, detail: unknown) {
  if (typeof message !== 'string') return
  const det = typeof detail === 'string' && detail ? detail : undefined
  log('error', 'renderer', message, det)
}

export function getLogsDir(): string {
  ensureLogFile()
  return logDir ?? app.getPath('logs')
}

export function openLogsFolder() {
  const dir = getLogsDir()
  shell.openPath(dir).then(
    (err) => {
      if (err) log('warn', 'diagnostics', `could not open logs folder: ${err}`)
    },
    (err: unknown) => log('warn', 'diagnostics', 'could not open logs folder', err),
  )
}

let initialised = false

/**
 * Call once, synchronously at startup, BEFORE app 'ready' (the crash reporter
 * must start early to cover child processes).
 */
export function initDiagnostics() {
  if (initialised) return
  initialised = true
  try {
    // Pin the default logs location so getPath('logs') is valid pre-ready.
    app.setAppLogsPath()
  } catch {
    // older platforms: getPath('logs') still falls back to a default
  }
  try {
    app.setPath('crashDumps', path.join(getLogsDir(), 'crashes'))
  } catch {
    // keep Electron's default crashDumps location
  }
  try {
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch (err) {
    log('warn', 'diagnostics', 'crash reporter failed to start', err)
  }

  log(
    'info',
    'app',
    `start v${app.getVersion()} ${process.platform} ${process.arch} electron ${process.versions.electron}${app.isPackaged ? '' : ' (dev)'}`,
  )

  process.on('uncaughtException', (err) => {
    log('error', 'main', 'uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    log('error', 'main', 'unhandledRejection', reason)
  })
  app.on('render-process-gone', (_e, wc, details) => {
    let url = ''
    try {
      url = wc.getURL().split('?')[0] ?? ''
    } catch {
      // destroyed
    }
    log(
      'error',
      'renderer',
      `render process gone: ${details.reason} (exit ${details.exitCode}) ${url}`,
    )
  })
  app.on('child-process-gone', (_e, details) => {
    log(
      details.reason === 'clean-exit' ? 'info' : 'error',
      'child',
      `${details.type}${details.name ? ` (${details.name})` : ''} gone: ${details.reason} (exit ${details.exitCode})`,
    )
  })
}
