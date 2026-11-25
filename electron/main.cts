import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
  webContents,
} from 'electron'
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
} from 'electron'
import * as path from 'path'
import {
  APP_INDEX_URL,
  APP_ORIGIN,
  handleAppScheme,
  registerAppScheme,
} from './appProtocol.cjs'
import { initDiagnostics, log, logRendererError, openLogsFolder } from './logger.cjs'
import * as media from './mediaStore.cjs'
import * as updater from './updater.cjs'

// Use the display name for the app's data, logs and single-instance lock
// (e.g. %APPDATA%\Dimi Intelligent Recorder) instead of the npm package name.
// Must run before anything reads app.getPath().
app.setName('Dimi Intelligent Recorder')

// Before anything else (and before 'ready'): file log + local crash dumps.
initDiagnostics()

// The production renderer is served from app://bundle (see appProtocol.cts).
// Privileged schemes must be registered before 'ready'.
registerAppScheme()

const DEV_URL = process.env['VITE_DEV_SERVER_URL']
const IS_MAC = process.platform === 'darwin'

/** Hosts the speech model is downloaded from (Hub + its file CDNs). */
const MODEL_HOSTS = 'https://huggingface.co https://*.huggingface.co https://*.hf.co'

// ── Custom title bar ───────────────────────────────────────────────────────
// The renderer draws its own title bar (logo, menu bar, project name — the
// Adobe-style layout). On Windows/Linux the native caption buttons are kept
// via titleBarOverlay (Snap Layouts, correct hit-testing); on macOS the
// traffic lights stay and the menu remains in the system menu bar.
/** Must match TITLE_BAR_HEIGHT in src/components/TitleBar.tsx. */
const TITLE_BAR_HEIGHT = 36
/** Must match the TitleBar background (dark theme). */
const TITLE_BAR_COLOR = '#0e1014'
const TITLE_BAR_SYMBOL_COLOR = '#c9ccd3'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null

// ── Recording / close state ────────────────────────────────────────────────
/** Mirrors the renderer's recording state (sent via 'tray:set-recording'). */
let isRecording = false
/** Mirrors the renderer's paused state (sent via 'tray:set-paused'). */
let isPaused = false
/** Set once the user confirmed "Stop & close" and the renderer finished. */
let allowClose = false
/** True while the "recording in progress" dialog or stop handshake is running. */
let closeInProgress = false
/** True when the close was triggered by an app quit (Cmd+Q / File ▸ Quit). */
let quitRequested = false
/** Resolver for the pending 'app:ready-to-close' handshake, if any. */
let resolveReadyToClose: (() => void) | null = null
/** Restarts the pending handshake's timeout (its length depends on isSaving). */
let rearmReadyToCloseTimer: (() => void) | null = null
/**
 * Mirrors the renderer's "a stopped take is being finalized and copied to the
 * recordings folder" state (sent via 'app:set-saving').
 */
let isSaving = false

/** How long to wait for an unresponsive renderer to confirm the close. */
const READY_TO_CLOSE_TIMEOUT_MS = 10_000
/**
 * While the renderer reports it is still saving a take (remux + disk copy of
 * a long recording can take minutes), wait this long before giving up.
 */
const SAVING_TIMEOUT_MS = 10 * 60_000

// ── Helpers ────────────────────────────────────────────────────────────────
function alive(win: BrowserWindow | null): win is BrowserWindow {
  return win !== null && !win.isDestroyed()
}

function isFromMain(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return alive(mainWindow) && e.sender === mainWindow.webContents
}

function isFromOverlay(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return alive(overlayWindow) && e.sender === overlayWindow.webContents
}

/** ipcMain.on wrapper: sender check + listener errors never crash main. */
function onIpc(
  channel: string,
  accept: (e: IpcMainEvent) => boolean,
  handler: (e: IpcMainEvent, ...args: unknown[]) => void,
) {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    if (!accept(e)) return
    try {
      handler(e, ...args)
    } catch (err) {
      log('error', 'ipc', `${channel} handler failed`, err)
    }
  })
}

/** ipcMain.handle wrapper: sender check + errors are logged, then rejected. */
function handleIpc(
  channel: string,
  accept: (e: IpcMainInvokeEvent) => boolean,
  handler: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) {
  ipcMain.handle(channel, async (e, ...args: unknown[]) => {
    if (!accept(e)) throw new Error(`${channel}: not allowed`)
    try {
      return await handler(e, ...args)
    } catch (err) {
      log('error', 'ipc', `${channel} handler failed`, err)
      // Only the message crosses IPC; keep it short and path-free-ish.
      throw new Error(err instanceof Error ? err.message : 'failed')
    }
  })
}

function sendToMain(channel: string, ...args: unknown[]) {
  if (alive(mainWindow)) mainWindow.webContents.send(channel, ...args)
}

/**
 * Commands sent before the page's menu bridge is listening (window just
 * created or reloading) are queued and delivered on 'menu:ready'. Otherwise a
 * tray / global-shortcut "Start Recording" with no window open was lost.
 */
let menuReady = false
const queuedCommands: string[] = []

function sendMenuCommand(id: string) {
  if (alive(mainWindow) && menuReady) {
    mainWindow.webContents.send('menu:command', id)
    return
  }
  // Only recording starts are worth delivering late; a queued stop/pause
  // would act on a take that no longer exists.
  if (id !== 'start-recording') return
  if (!queuedCommands.includes(id)) queuedCommands.push(id)
  showMainWindow()
}

function showMainWindow() {
  if (!alive(mainWindow)) {
    if (app.isReady()) createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleRecording() {
  sendMenuCommand(isRecording ? 'stop-recording' : 'start-recording')
}

// ── Tray helpers ───────────────────────────────────────────────────────────
/**
 * Build a 16×16 monochrome PNG via raw RGBA bytes — avoids shipping extra
 * icon asset files for the tray dot.  The 4-byte RGBA encoding gives us a
 * simple filled circle.
 */
function makeTrayIcon(recording: boolean): Electron.NativeImage {
  // 16×16 RGBA buffer — all pixels start transparent.
  const size = 16
  const buf = Buffer.alloc(size * size * 4, 0)
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 1
  const [red, green, blue] = recording ? [220, 50, 50] : [160, 160, 160]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5
      const dy = y - cy + 0.5
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * size + x) * 4
        buf[i] = red!
        buf[i + 1] = green!
        buf[i + 2] = blue!
        buf[i + 3] = 255
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Show Window', click: showMainWindow },
    { type: 'separator' },
    isRecording
      ? { label: 'Stop Recording', click: () => sendMenuCommand('stop-recording') }
      : {
          label: 'Start Recording',
          click: () => {
            showMainWindow()
            sendMenuCommand('start-recording')
          },
        },
    {
      label: isRecording && isPaused ? 'Resume Recording' : 'Pause Recording',
      enabled: isRecording,
      click: () => sendMenuCommand('pause-recording'),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return
  tray.setImage(makeTrayIcon(isRecording))
  tray.setToolTip(
    !isRecording
      ? 'Dimi Intelligent Recorder'
      : isPaused
        ? 'Dimi Intelligent Recorder — Paused'
        : 'Dimi Intelligent Recorder — Recording…',
  )
  tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  tray = new Tray(makeTrayIcon(false))
  tray.on('click', showMainWindow)
  updateTray()
}

// ── Global shortcuts ───────────────────────────────────────────────────────
// Ctrl+Alt+Shift combos: plain Ctrl+Shift+R / Ctrl+Shift+P are claimed by
// browsers and editors (hard reload, command palette) and a global shortcut
// would steal them system-wide.
const GLOBAL_TOGGLE_RECORDING = 'CmdOrCtrl+Alt+Shift+R'
const GLOBAL_PAUSE_RECORDING = 'CmdOrCtrl+Alt+Shift+P'

function registerGlobalShortcuts() {
  const ok1 = globalShortcut.register(GLOBAL_TOGGLE_RECORDING, toggleRecording)
  const ok2 = globalShortcut.register(GLOBAL_PAUSE_RECORDING, () => {
    if (isRecording) sendMenuCommand('pause-recording')
  })
  if (!ok1 || !ok2)
    log('warn', 'shortcuts', 'some global shortcuts are taken by another app')
}

// ── Response headers: cross-origin isolation + Content-Security-Policy ────
/** COOP/COEP make the page cross-origin isolated (SharedArrayBuffer). */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * Production CSP, sent with every app://bundle response (page and workers).
 * 'wasm-unsafe-eval': WebAssembly compilation only (ONNX Runtime for
 * on-device transcription) — it does not enable JS eval(). connect-src
 * Hugging Face: one-time download of the speech model, which is then cached
 * in OPFS (see src/workers/transcribe.worker.ts).
 */
const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; " +
  `connect-src 'self' blob: data: ${MODEL_HOSTS}; font-src 'self' data:; ` +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Production: serve dist/ on app://bundle with the headers above. */
function serveApp() {
  handleAppScheme(path.join(__dirname, '../dist'), {
    ...ISOLATION_HEADERS,
    'Content-Security-Policy': PRODUCTION_CSP,
  })
}

/**
 * Dev: the Vite server already sends COOP/COEP for its own responses; add them
 * to every response so the page stays isolated. No CSP (HMR needs eval and a
 * WebSocket).
 */
function applyDevIsolation(ses: Electron.Session) {
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) responseHeaders[k] = [v]
    callback({ responseHeaders })
  })
}

// ── Security: what counts as the app's own page ───────────────────────────
/**
 * `scheme://host[:port]` of a URL, or null. Not URL#origin: for a custom
 * scheme like app:// that is the string "null".
 */
function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}
/** The origin the app's page is served from (Vite in dev, app://bundle). */
const PAGE_ORIGIN = DEV_URL ? originOf(DEV_URL) : APP_ORIGIN

/**
 * True for the app's own windows (main + webcam overlay) showing the app's
 * own page (app://bundle, or the Vite origin in dev). Permission and capture
 * requests from anything else — another origin, a stray frame — are denied.
 */
function isAppPage(wc: Electron.WebContents | null, url: string | undefined): boolean {
  const ours =
    !!wc &&
    ((alive(mainWindow) && wc === mainWindow.webContents) ||
      (alive(overlayWindow) && wc === overlayWindow.webContents))
  return ours && !!url && originOf(url) === PAGE_ORIGIN
}

// ── Security: block external navigation & new windows ─────────────────────
function lockNavigation(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' as const }))
  win.webContents.on('will-navigate', (event, url) => {
    // In dev, allow only the Vite origin. In production, allow only the app's
    // own index page — no other origin or local file.
    let allowed = originOf(url) === PAGE_ORIGIN
    if (allowed && !DEV_URL) allowed = new URL(url).pathname === '/index.html'
    if (!allowed) event.preventDefault()
  })
}

// ── Close-while-recording flow ─────────────────────────────────────────────
/**
 * Ask the renderer to stop any recording, finish saving every take to the
 * recordings folder and flush autosave, then resolve once it replies with
 * 'app:ready-to-close' or after a timeout. The timeout is long while the
 * renderer reports it is still saving, short otherwise.
 */
function stopRecordingInRenderer(): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(
        () => {
          log('warn', 'close', 'renderer did not confirm in time — closing anyway')
          done()
        },
        isSaving ? SAVING_TIMEOUT_MS : READY_TO_CLOSE_TIMEOUT_MS,
      )
    }
    function done() {
      clearTimeout(timer)
      resolveReadyToClose = null
      rearmReadyToCloseTimer = null
      resolve()
    }
    resolveReadyToClose = done
    rearmReadyToCloseTimer = arm
    arm()
    sendToMain('app:stop-recording-and-close')
  })
}

/**
 * Hide the window (the close feels immediate), let the renderer finish
 * saving, then really close / quit.
 */
async function finishThenClose(win: BrowserWindow) {
  if (!win.isDestroyed()) win.hide()
  await stopRecordingInRenderer()
  allowClose = true
  if (quitRequested) app.quit()
  else if (!win.isDestroyed()) win.close()
}

/** Closing while a stopped take is still being saved: wait for it. */
async function closeAfterSaving(win: BrowserWindow) {
  closeInProgress = true
  try {
    log('info', 'close', 'waiting for the recording to finish saving')
    await finishThenClose(win)
  } catch (err) {
    log('error', 'close', 'close after saving failed', err)
    quitRequested = false
  } finally {
    closeInProgress = false
  }
}

async function confirmCloseWhileRecording(win: BrowserWindow) {
  closeInProgress = true
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Stop & Close', 'Keep Recording'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Recording in progress',
      message: 'A recording is in progress.',
      detail: 'Stop the recording and save the project before closing?',
    })
    if (response !== 0) {
      quitRequested = false
      return
    }
    await finishThenClose(win)
  } catch (err) {
    log('error', 'close', 'confirmation failed', err)
    quitRequested = false
  } finally {
    closeInProgress = false
  }
}

// ── Main window ────────────────────────────────────────────────────────────
function createMainWindow() {
  allowClose = false
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    show: false,
    title: 'Dimi Intelligent Recorder',
    ...(IS_MAC
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 11 },
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: TITLE_BAR_COLOR,
            symbolColor: TITLE_BAR_SYMBOL_COLOR,
            height: TITLE_BAR_HEIGHT,
          },
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep recording timers / canvas crop pipelines running when the
      // window is minimized or hidden.
      backgroundThrottling: false,
    },
  })
  mainWindow = win

  lockNavigation(win)

  if (DEV_URL) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadURL(APP_INDEX_URL)
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
  })

  win.on('close', (event) => {
    if (allowClose) return
    if (isRecording) {
      event.preventDefault()
      if (!closeInProgress) void confirmCloseWhileRecording(win)
    } else if (isSaving) {
      event.preventDefault()
      if (!closeInProgress) void closeAfterSaving(win)
    }
  })

  // A crashed/reloaded renderer can no longer report its recording state.
  win.webContents.on('render-process-gone', () => {
    menuReady = false
    media.closeAllWrites()
    isRecording = false
    isSaving = false
    updateTray()
    resolveReadyToClose?.()
  })
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    // A reload orphans the previous page's open writes.
    if (isMainFrame && !isInPlace) {
      menuReady = false
      media.closeAllWrites()
      isSaving = false
    }
    if (isMainFrame && !isInPlace && isRecording) {
      isRecording = false
      updateTray()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    menuReady = false
    media.closeAllWrites()
    isRecording = false
    isSaving = false
    updateTray()
    if (alive(overlayWindow)) overlayWindow.close()
    overlayWindow = null
  })
}

// ── Overlay window ─────────────────────────────────────────────────────────
interface OverlayOpts {
  x: number
  y: number
  width: number
  height: number
  deviceId?: string
  mirrored?: boolean
}

const OVERLAY_MIN = 80
const OVERLAY_MAX = 4000
const MAX_ID_LEN = 512

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function asFiniteInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

function asOptionalId(v: unknown): string | undefined | null {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > MAX_ID_LEN) return null
  return v
}

function asOptionalBool(v: unknown): boolean | undefined | null {
  if (v === undefined) return undefined
  return typeof v === 'boolean' ? v : null
}

function parseOverlayParams(
  raw: unknown,
): { deviceId?: string; mirrored?: boolean } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const deviceId = asOptionalId(r['deviceId'])
  const mirrored = asOptionalBool(r['mirrored'])
  if (deviceId === null || mirrored === null) return null
  const out: { deviceId?: string; mirrored?: boolean } = {}
  if (deviceId !== undefined) out.deviceId = deviceId
  if (mirrored !== undefined) out.mirrored = mirrored
  return out
}

/** Validate + sanitise renderer-supplied overlay bounds. Returns null if invalid. */
function parseOverlayOpts(raw: unknown): OverlayOpts | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const x = asFiniteInt(r['x'])
  const y = asFiniteInt(r['y'])
  const w = asFiniteInt(r['width'])
  const h = asFiniteInt(r['height'])
  if (x === null || y === null || w === null || h === null) return null
  const params = parseOverlayParams(raw)
  if (!params) return null

  const width = clamp(w, OVERLAY_MIN, OVERLAY_MAX)
  const height = clamp(h, OVERLAY_MIN, OVERLAY_MAX)

  // Keep the window origin inside the union of all display bounds.
  const displays = screen.getAllDisplays()
  let minX = 0
  let minY = 0
  let maxX = OVERLAY_MAX
  let maxY = OVERLAY_MAX
  if (displays.length > 0) {
    minX = Math.min(...displays.map((d) => d.bounds.x))
    minY = Math.min(...displays.map((d) => d.bounds.y))
    maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
    maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
  }
  return {
    x: clamp(x, minX, Math.max(minX, maxX - OVERLAY_MIN)),
    y: clamp(y, minY, Math.max(minY, maxY - OVERLAY_MIN)),
    width,
    height,
    ...params,
  }
}

function createOrUpdateOverlay(opts: OverlayOpts) {
  // Reuse existing window if it's still alive
  if (alive(overlayWindow)) {
    overlayWindow.setBounds({
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
    })
    overlayWindow.webContents.send('overlay:set-params', {
      deviceId: opts.deviceId,
      mirrored: opts.mirrored,
    })
    overlayWindow.showInactive()
    return
  }

  const win = new BrowserWindow({
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  overlayWindow = win

  // Float above full-screen apps, all virtual desktops
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  lockNavigation(win)

  const deviceParam = opts.deviceId
    ? `&deviceId=${encodeURIComponent(opts.deviceId)}`
    : ''
  const mirrorParam = opts.mirrored ? '&mirrored=1' : ''

  if (DEV_URL) {
    void win.loadURL(`${DEV_URL}?overlay=1${deviceParam}${mirrorParam}`)
  } else {
    const url = new URL(APP_INDEX_URL)
    url.searchParams.set('overlay', '1')
    if (opts.deviceId) url.searchParams.set('deviceId', opts.deviceId)
    if (opts.mirrored) url.searchParams.set('mirrored', '1')
    void win.loadURL(url.href)
  }

  win.on('closed', () => {
    // If a newer overlay already replaced this one, leave it (and the
    // renderer's state) alone.
    const wasCurrent = overlayWindow === win || overlayWindow === null
    if (overlayWindow === win) overlayWindow = null
    // Tell the main renderer the overlay was closed
    if (wasCurrent) sendToMain('overlay:closed')
  })

  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('overlay:fullscreen-changed', true)
  })

  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('overlay:fullscreen-changed', false)
  })
}

// ── IPC handlers ───────────────────────────────────────────────────────────
const fromMainOrOverlay = (e: IpcMainEvent) => isFromMain(e) || isFromOverlay(e)

onIpc('overlay:show', isFromMain, (_e, raw) => {
  const opts = parseOverlayOpts(raw)
  if (opts) createOrUpdateOverlay(opts)
})

onIpc('overlay:hide', isFromMain, () => {
  if (alive(overlayWindow)) overlayWindow.hide()
})

// Sent by both the main renderer (electronAPI.overlay.destroy) and the
// overlay itself (overlayAPI.close).
onIpc('overlay:destroy', fromMainOrOverlay, () => {
  if (alive(overlayWindow)) overlayWindow.close()
})

onIpc('overlay:set-always-on-top', isFromMain, (_e, flag) => {
  if (typeof flag !== 'boolean' || !alive(overlayWindow)) return
  if (flag) overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  else overlayWindow.setAlwaysOnTop(false)
})

onIpc('overlay:set-fullscreen', isFromOverlay, (_e, flag) => {
  if (typeof flag !== 'boolean' || !alive(overlayWindow)) return
  overlayWindow.setFullScreen(flag)
})

onIpc('overlay:update-params', isFromMain, (_e, raw) => {
  const params = parseOverlayParams(raw)
  if (params && alive(overlayWindow))
    overlayWindow.webContents.send('overlay:set-params', params)
})

// ── Desktop Capturer IPC ───────────────────────────────────────────────────
// Source ID chosen by the renderer's RecordSetupModal before getDisplayMedia.
let pendingSourceId: string | null = null
// Track IDs returned by the last get-sources call so set-source can be validated.
let cachedSourceIds = new Set<string>()

ipcMain.handle('desktopCapturer:get-sources', async (e) => {
  if (!isFromMain(e)) return []
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  })
  // Cache the valid source IDs so set-source can reject spoofed IDs.
  cachedSourceIds = new Set(sources.map((s) => s.id))
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon?.toDataURL() ?? null,
  }))
})

ipcMain.handle('desktopCapturer:set-source', (e, id: unknown) => {
  if (!isFromMain(e)) return
  if (id !== null && typeof id !== 'string') return
  // Reject any ID that was not in the most recent get-sources response.
  if (id !== null && !cachedSourceIds.has(id)) return
  pendingSourceId = id
})

// ── Tray / recording-state IPC ─────────────────────────────────────────────
onIpc('tray:set-recording', isFromMain, (_e, recording) => {
  if (typeof recording !== 'boolean') return
  isRecording = recording
  if (!recording) isPaused = false
  updateTray()
})

onIpc('tray:set-paused', isFromMain, (_e, paused) => {
  if (typeof paused !== 'boolean') return
  isPaused = isRecording && paused
  updateTray()
})

// ── App lifecycle IPC ──────────────────────────────────────────────────────
onIpc('menu:ready', isFromMain, () => {
  menuReady = true
  for (const id of queuedCommands.splice(0)) sendMenuCommand(id)
})

onIpc('app:ready-to-close', isFromMain, () => {
  resolveReadyToClose?.()
})
onIpc('app:set-saving', isFromMain, (_e, saving) => {
  if (typeof saving !== 'boolean') return
  isSaving = saving
  // A close is waiting: switch between the short and the long timeout.
  rearmReadyToCloseTimer?.()
})

// ── Media (recordings folder) IPC ─────────────────────────────────────────
handleIpc('media:get-folder', isFromMain, () => media.getFolder())
handleIpc('media:choose-folder', isFromMain, () => chooseMediaFolder(false))
onIpc('media:reveal', isFromMain, (_e, absPath) => {
  void media.reveal(absPath).catch((err: unknown) => {
    log('warn', 'media', 'reveal failed', err)
  })
})
handleIpc('media:open-write', isFromMain, (_e, relPath) => media.openWrite(relPath))
handleIpc('media:write', isFromMain, (_e, id, data) => media.write(id, data))
handleIpc('media:close-write', isFromMain, (_e, id) => media.closeWrite(id))
handleIpc('media:abort-write', isFromMain, (_e, id) => media.abortWrite(id))
handleIpc('media:stat', isFromMain, (_e, absPath) => media.stat(absPath))
handleIpc('media:read', isFromMain, (_e, absPath, offset, length) =>
  media.read(absPath, offset, length),
)
onIpc('media:allow-import', isFromMain, (_e, absPath) => {
  media.allowImport(absPath)
})

/** Folder picker shared by IPC and File ▸ Change Recordings Folder…. */
async function chooseMediaFolder(fromMenu: boolean): Promise<string | null> {
  const picked = await media.chooseFolder(alive(mainWindow) ? mainWindow : null)
  if (picked && fromMenu) sendMenuCommand('media-folder-changed')
  return picked
}

// ── Updates & diagnostics IPC ──────────────────────────────────────────────
onIpc('updates:check', isFromMain, () => {
  updater.checkNow()
})
onIpc('updates:install', isFromMain, () => {
  updater.installAndRestart()
})
onIpc('updates:replay', isFromMain, () => {
  updater.replayStatus()
})
onIpc('updates:open-releases', isFromMain, () => {
  updater.openReleasesPage()
})
onIpc('diagnostics:log-error', isFromMain, (_e, message, detail) => {
  logRendererError(message, detail)
})
onIpc('diagnostics:open-logs', isFromMain, () => {
  openLogsFolder()
})

// ── Application menu ───────────────────────────────────────────────────────
/**
 * Accelerator shown in the menu label but NOT registered with the OS, so the
 * key still reaches text inputs (the renderer handles it itself). On macOS
 * `registerAccelerator` is ignored, so we omit bare-key accelerators there.
 */
function displayOnly(accelerator: string): Partial<MenuItemConstructorOptions> {
  return IS_MAC ? {} : { accelerator, registerAccelerator: false }
}

function buildAppMenu(): Menu {
  const send = (id: string) => () => sendMenuCommand(id)

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click: send('new-project'),
        },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: send('open-project'),
        },
        {
          label: 'Save Project',
          accelerator: 'CmdOrCtrl+S',
          click: send('save-project'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: send('save-project-as'),
        },
        { type: 'separator' },
        {
          label: 'Import Media…',
          accelerator: 'CmdOrCtrl+I',
          click: send('import-media'),
        },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        {
          label: 'Change Recordings Folder…',
          click: () => {
            void chooseMediaFolder(true).catch((err: unknown) => {
              log('error', 'media', 'choose folder failed', err)
            })
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Timeline undo/redo: the renderer's own Ctrl/Cmd+Z handler (which
        // skips text inputs) owns the keys, so text fields keep native undo.
        { label: 'Undo', ...displayOnly('CmdOrCtrl+Z'), click: send('undo') },
        { label: 'Redo', ...displayOnly('CmdOrCtrl+Shift+Z'), click: send('redo') },
        // macOS routes Cmd+Z in text fields through the responder chain, which
        // needs role items; hidden ones keep their key equivalents working.
        ...(IS_MAC
          ? ([
              { role: 'undo', visible: false },
              { role: 'redo', visible: false },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { type: 'separator' },
        // The roles fire DOM cut / copy / paste events: the renderer copies
        // timeline clips there when focus isn't in a text field.
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        {
          label: 'Paste Attributes…',
          ...displayOnly('CmdOrCtrl+Alt+V'),
          click: send('paste-attributes'),
        },
        { role: 'selectAll' },
        { type: 'separator' },
        // Layer order (flat: the in-app menu bar has no nested submenus).
        {
          label: 'Bring Forward',
          ...displayOnly('CmdOrCtrl+]'),
          click: send('bring-forward'),
        },
        {
          label: 'Send Backward',
          ...displayOnly('CmdOrCtrl+['),
          click: send('send-backward'),
        },
        {
          label: 'Bring to Front',
          ...displayOnly('CmdOrCtrl+Shift+]'),
          click: send('bring-to-front'),
        },
        {
          label: 'Send to Back',
          ...displayOnly('CmdOrCtrl+Shift+['),
          click: send('send-to-back'),
        },
        { type: 'separator' },
        {
          label: 'Split at Playhead',
          ...displayOnly('S'),
          click: send('split-at-playhead'),
        },
        { label: 'Add Marker', ...displayOnly('M'), click: send('add-marker') },
        { type: 'separator' },
        {
          label: 'Delete Selected',
          ...displayOnly('Delete'),
          click: send('delete-selected'),
        },
        {
          label: 'Ripple Delete',
          ...displayOnly('Shift+Delete'),
          click: send('ripple-delete'),
        },
        { type: 'separator' },
        { label: 'Select All Clips', click: send('select-all') },
      ],
    },
    {
      label: 'Recording',
      submenu: [
        {
          label: 'Start Recording',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: send('start-recording'),
        },
        { label: 'Stop Recording', click: send('stop-recording') },
        { label: 'Pause / Resume', click: send('pause-recording') },
        { type: 'separator' },
        {
          label: 'Toggle Recording (global)',
          accelerator: GLOBAL_TOGGLE_RECORDING,
          registerAccelerator: false,
          click: toggleRecording,
        },
        { type: 'separator' },
        { label: 'Record Setup…', click: send('record-setup') },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Media Library',
          accelerator: 'CmdOrCtrl+1',
          click: send('toggle-library'),
        },
        {
          label: 'Toggle Inspector',
          accelerator: 'CmdOrCtrl+2',
          click: send('toggle-inspector'),
        },
        { type: 'separator' },
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+K',
          click: send('open-command-palette'),
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Fit Timeline', click: send('zoom-fit') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          ...displayOnly('?'),
          click: send('show-shortcuts'),
        },
        { type: 'separator' },
        {
          label: 'Open Recordings Folder',
          click: () => {
            void media.reveal(undefined).catch((err: unknown) => {
              log('warn', 'media', 'reveal failed', err)
            })
          },
        },
        { label: 'Open Logs Folder', click: openLogsFolder },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            // Tells the renderer's UpdateNotice this check is user-initiated,
            // so it also shows "up to date" / errors.
            sendMenuCommand('check-for-updates')
            updater.checkNow()
          },
        },
        { type: 'separator' },
        { label: 'About Dimi Intelligent Recorder', click: send('about') },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}

// ── In-app menu bar (custom title bar) ────────────────────────────────────
// The renderer's menu bar is generated from the real application menu so the
// two can never drift apart. Items are addressed by their index path;
// clicking one runs the native MenuItem's own click (including roles such as
// cut/copy/paste/quit), exactly as if it were chosen from a native menu.
let appMenu: Menu | null = null

interface MenuModelItem {
  path: number[]
  label: string
  type: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  accelerator: string | null
  role: string | null
  enabled: boolean
  checked: boolean
  submenu?: MenuModelItem[]
}

function serializeMenu(menu: Menu, prefix: number[] = []): MenuModelItem[] {
  const out: MenuModelItem[] = []
  menu.items.forEach((item, i) => {
    if (!item.visible) return
    const path = [...prefix, i]
    const accel = item.accelerator
    out.push({
      path,
      label: item.label.replace(/&/g, ''),
      // 'header' / 'palette' (newer macOS-only types) aren't used by this
      // menu; map them to the closest type the title-bar menu understands.
      type:
        item.type === 'palette'
          ? 'submenu'
          : item.type === 'header'
            ? 'normal'
            : item.type,
      accelerator: typeof accel === 'string' && accel ? accel : null,
      role: item.role ?? null,
      enabled: item.enabled,
      checked: item.checked,
      ...(item.submenu ? { submenu: serializeMenu(item.submenu, path) } : {}),
    })
  })
  return out
}

function menuItemAt(path: number[]): Electron.MenuItem | null {
  let menu: Menu | null = appMenu
  let item: Electron.MenuItem | null = null
  for (const i of path) {
    if (!menu || !Number.isInteger(i) || i < 0 || i >= menu.items.length) return null
    item = menu.items[i] ?? null
    menu = item?.submenu ?? null
  }
  return item
}

ipcMain.handle('menu:get-model', (e) => {
  if (!isFromMain(e) || !appMenu) return []
  return serializeMenu(appMenu)
})

onIpc('menu:click', isFromMain, (_e, rawPath) => {
  if (!Array.isArray(rawPath) || rawPath.length === 0 || rawPath.length > 4) return
  const path = rawPath.map(Number)
  const item = menuItemAt(path)
  if (!item || !item.enabled || !item.visible || item.submenu) return
  if (!alive(mainWindow)) return
  const click = item.click as (
    event: Electron.KeyboardEvent,
    focusedWindow: BrowserWindow,
    focusedWebContents: Electron.WebContents,
  ) => void
  click({} as Electron.KeyboardEvent, mainWindow, mainWindow.webContents)
})

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
/** Theme change: recolor the native caption buttons to match the title bar. */
onIpc('window:set-titlebar-colors', isFromMain, (_e, raw) => {
  if (IS_MAC || !alive(mainWindow)) return
  const c = raw as { color?: unknown; symbolColor?: unknown } | null
  if (typeof c?.color !== 'string' || typeof c.symbolColor !== 'string') return
  if (!HEX_COLOR.test(c.color) || !HEX_COLOR.test(c.symbolColor)) return
  mainWindow.setTitleBarOverlay({
    color: c.color,
    symbolColor: c.symbolColor,
    height: TITLE_BAR_HEIGHT,
  })
})

// ── App lifecycle ──────────────────────────────────────────────────────────
// Two instances would share OPFS/IndexedDB and clobber each other's autosave.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.on('before-quit', () => {
    quitRequested = true
    media.flushSettings()
  })

  app
    .whenReady()
    .then(() => {
      // Install custom application menu
      appMenu = buildAppMenu()
      Menu.setApplicationMenu(appMenu)

      createTray()
      registerGlobalShortcuts()
      if (DEV_URL) applyDevIsolation(session.defaultSession)
      else serveApp()

      // Only the app's own windows, showing the app's own page, get anything.
      // 'media' covers camera and microphone; since Electron 45 screen capture
      // (getDisplayMedia) is requested separately as 'display-capture';
      // 'fullscreen' is the webcam view's full-screen button. Every other
      // permission (geolocation, notifications, clipboard-read, pointerLock,
      // openExternal, etc.) is denied.
      const GRANTED = new Set(['media', 'display-capture', 'fullscreen'])
      session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
          callback(
            isAppPage(webContents, details.requestingUrl) && GRANTED.has(permission),
          )
        },
      )
      session.defaultSession.setPermissionCheckHandler(
        (webContents, _permission, origin) => isAppPage(webContents, origin),
      )

      // Handle getDisplayMedia() — use the source the user chose in the
      // recording setup (desktopCapturer:set-source IPC); it stays selected
      // for every later take until changed. Quick-record with nothing chosen
      // records the primary screen. A chosen source that has since
      // disappeared (window closed) is denied so the renderer shows an error
      // instead of silently recording the wrong thing.
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        const requester = request.frame
          ? webContents.fromFrame(request.frame)
          : undefined
        if (!isAppPage(requester ?? null, request.securityOrigin)) {
          callback({})
          return
        }
        const wanted = pendingSourceId
        desktopCapturer
          .getSources({ types: ['screen', 'window'] })
          .then((sources) => {
            const source = wanted ? sources.find((s) => s.id === wanted) : sources[0]
            if (!source) {
              callback({})
              return
            }
            // System-audio loopback is Windows-only.
            if (process.platform === 'win32' && request.audioRequested) {
              callback({ video: source, audio: 'loopback' })
            } else {
              callback({ video: source })
            }
          })
          .catch(() => callback({}))
      })

      createMainWindow()

      updater.initUpdater({
        send: (status) => sendToMain(updater.UPDATE_STATUS_CHANNEL, status),
        isRecording: () => isRecording,
        getWindow: () => (alive(mainWindow) ? mainWindow : null),
      })
    })
    .catch((err: unknown) => {
      log('error', 'app', 'startup failed', err)
    })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit()
  })

  app.on('activate', () => {
    if (!alive(mainWindow)) createMainWindow()
  })
}
