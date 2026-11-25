import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'

/** Mirrors `UpdateStatus` in src/lib/electronAPI.ts. */
type UpdateStatus =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'available'; version: string }
  | { state: 'manual'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

const MAX_LOG_MESSAGE = 2000
const MAX_LOG_DETAIL = 8000

/**
 * Exposed on window.electronAPI in the main renderer window.
 * Provides safe, contextIsolation-compatible access to Electron features.
 *
 * The canonical type for this object is `ElectronAPI` in
 * `src/lib/electronAPI.ts`.  When adding new methods here, update that file
 * first so the renderer TypeScript types stay in sync.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true as const,
  platform: process.platform,

  overlay: {
    show(opts: {
      x: number
      y: number
      width: number
      height: number
      deviceId?: string
      mirrored?: boolean
    }) {
      ipcRenderer.send('overlay:show', opts)
    },

    hide() {
      ipcRenderer.send('overlay:hide')
    },

    destroy() {
      ipcRenderer.send('overlay:destroy')
    },

    updateParams(params: { mirrored?: boolean; deviceId?: string }) {
      ipcRenderer.send('overlay:update-params', params)
    },

    setAlwaysOnTop(flag: boolean) {
      ipcRenderer.send('overlay:set-always-on-top', flag)
    },

    onClosed(cb: () => void): () => void {
      // Like every subscription here: add one listener, return its remover
      // (callers unsubscribe in their effect cleanup).
      const listener = () => cb()
      ipcRenderer.on('overlay:closed', listener)
      return () => ipcRenderer.removeListener('overlay:closed', listener)
    },
  },

  desktop: {
    /** Return all capturable screens and windows with thumbnail data-URLs. */
    getSources(): Promise<
      {
        id: string
        name: string
        thumbnail: string
        appIcon: string | null
      }[]
    > {
      return ipcRenderer.invoke('desktopCapturer:get-sources') as Promise<
        {
          id: string
          name: string
          thumbnail: string
          appIcon: string | null
        }[]
      >
    },

    /**
     * Pre-select a desktop source ID so the next getDisplayMedia() call in the
     * main process returns that specific screen/window instead of screen 0.
     * Returns a Promise so callers can await delivery before calling getDisplayMedia.
     */
    async setSource(id: string | null): Promise<void> {
      await ipcRenderer.invoke('desktopCapturer:set-source', id)
    },
  },

  tray: {
    setRecording(recording: boolean): void {
      ipcRenderer.send('tray:set-recording', recording)
    },
    setPaused(paused: boolean): void {
      ipcRenderer.send('tray:set-paused', paused)
    },
  },

  app: {
    /**
     * Fired when the user chose "Stop & close" while recording. The renderer
     * must stop the recording, flush autosave, then call readyToClose().
     * Returns an unsubscribe function.
     */
    onStopAndClose(cb: () => void): () => void {
      const listener = () => cb()
      ipcRenderer.on('app:stop-recording-and-close', listener)
      return () => ipcRenderer.removeListener('app:stop-recording-and-close', listener)
    },

    /** Tell the main process the recording stopped and the project is saved. */
    readyToClose(): void {
      ipcRenderer.send('app:ready-to-close')
    },

    /** A stopped take is (true) / is no longer (false) being saved to disk. */
    setSaving(saving: boolean): void {
      ipcRenderer.send('app:set-saving', saving === true)
    },
  },

  menu: {
    /**
     * Register a callback that fires whenever the main-process menu sends a
     * command ID (e.g. 'export', 'undo', 'toggle-library').
     * Returns an unsubscribe function — call it in useEffect cleanup.
     */
    onCommand(cb: (id: string) => void): () => void {
      const listener = (_e: unknown, id: string) => cb(id)
      ipcRenderer.on('menu:command', listener)
      return () => ipcRenderer.removeListener('menu:command', listener)
    },

    /** The page's command handlers are installed: deliver queued commands. */
    ready(): void {
      ipcRenderer.send('menu:ready')
    },

    /** The application menu as plain data, for the in-app menu bar. */
    getModel(): Promise<unknown> {
      return ipcRenderer.invoke('menu:get-model')
    },

    /** Activate the application-menu item at `path` (indices from getModel). */
    click(path: number[]): void {
      ipcRenderer.send('menu:click', path)
    },
  },

  window: {
    /** Recolor the native caption buttons (Windows/Linux) to match the theme. */
    setTitleBarColors(colors: { color: string; symbolColor: string }): void {
      ipcRenderer.send('window:set-titlebar-colors', colors)
    },
  },

  /** Real files in the recordings folder (see electron/mediaStore.cts). */
  media: {
    getFolder(): Promise<string> {
      return ipcRenderer.invoke('media:get-folder') as Promise<string>
    },
    chooseFolder(): Promise<string | null> {
      return ipcRenderer.invoke('media:choose-folder') as Promise<string | null>
    },
    reveal(absPath?: string): void {
      ipcRenderer.send('media:reveal', absPath)
    },
    openWrite(relPath: string): Promise<{ id: number; path: string }> {
      return ipcRenderer.invoke('media:open-write', relPath) as Promise<{
        id: number
        path: string
      }>
    },
    async write(id: number, data: Uint8Array): Promise<void> {
      await ipcRenderer.invoke('media:write', id, data)
    },
    async closeWrite(id: number): Promise<void> {
      await ipcRenderer.invoke('media:close-write', id)
    },
    async abortWrite(id: number): Promise<void> {
      await ipcRenderer.invoke('media:abort-write', id)
    },
    stat(absPath: string): Promise<number> {
      return ipcRenderer.invoke('media:stat', absPath) as Promise<number>
    },
    read(absPath: string, offset: number, length: number): Promise<Uint8Array> {
      return ipcRenderer.invoke(
        'media:read',
        absPath,
        offset,
        length,
      ) as Promise<Uint8Array>
    },
    registerImport(file: File): string {
      let p = ''
      try {
        p = webUtils.getPathForFile(file)
      } catch {
        return ''
      }
      if (!p) return ''
      ipcRenderer.send('media:allow-import', p)
      return p
    },
  },

  updates: {
    onStatus(cb: (status: UpdateStatus) => void): () => void {
      const listener = (_e: IpcRendererEvent, status: UpdateStatus) => cb(status)
      ipcRenderer.on('updates:status', listener)
      // Ask main to re-send the latest status (e.g. after a renderer reload).
      ipcRenderer.send('updates:replay')
      return () => ipcRenderer.removeListener('updates:status', listener)
    },
    checkNow(): void {
      ipcRenderer.send('updates:check')
    },
    installAndRestart(): void {
      ipcRenderer.send('updates:install')
    },
    openReleasesPage(): void {
      ipcRenderer.send('updates:open-releases')
    },
  },

  diagnostics: {
    logError(message: string, detail?: string): void {
      ipcRenderer.send(
        'diagnostics:log-error',
        String(message).slice(0, MAX_LOG_MESSAGE),
        typeof detail === 'string' ? detail.slice(0, MAX_LOG_DETAIL) : undefined,
      )
    },
    openLogsFolder(): void {
      ipcRenderer.send('diagnostics:open-logs')
    },
  },
})
