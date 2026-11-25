/**
 * Canonical type for the object exposed on `window.electronAPI` by
 * `electron/preload.cts` via contextBridge.
 *
 * Both `src/electron.d.ts` (renderer types) and `electron/preload.cts`
 * (the actual implementation) must stay in sync with this interface.
 * When adding a new IPC method, update this file first.
 *
 * NOTE: `electron/preload.cts` is compiled under a separate tsconfig
 * (tsconfig.electron.json) that targets the Node.js environment and cannot
 * directly import this file.  The preload.cts imports this file for
 * type-checking purposes only (import type) when the TypeScript paths allow;
 * otherwise the comment in preload.cts serves as the sync anchor.
 */

import type { DesktopSourceInfo } from '../electron.d'

/** One entry of the application menu, as sent by main for the in-app menu bar. */
export interface MenuModelItem {
  /** Index path into the native menu; pass to `menu.click()`. */
  path: number[]
  label: string
  type: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  /** Electron accelerator string (e.g. 'CmdOrCtrl+Shift+S'), display only. */
  accelerator: string | null
  /** Electron role (e.g. 'copy', 'quit') for built-in items, else null. */
  role: string | null
  enabled: boolean
  checked: boolean
  submenu?: MenuModelItem[]
}

/** Auto-update state, pushed from the main process (packaged builds only). */
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'available'; version: string }
  /** Unsigned build: an update exists but is never downloaded automatically. */
  | { state: 'manual'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export interface ElectronAPI {
  readonly isElectron: true
  /** Node's process.platform ('win32' | 'darwin' | 'linux' | …). */
  readonly platform: string

  overlay: {
    /** Open (or reposition) the floating webcam overlay OS window. */
    show(opts: {
      x: number
      y: number
      width: number
      height: number
      deviceId?: string | undefined
      mirrored?: boolean
    }): void
    /** Hide the overlay without destroying it. */
    hide(): void
    /** Close and destroy the overlay window. */
    destroy(): void
    /** Push updated params (mirror, deviceId) into the live overlay. */
    updateParams(params: { mirrored?: boolean; deviceId?: string }): void
    /** Pin / unpin the overlay above all other windows. */
    setAlwaysOnTop(flag: boolean): void
    /**
     * Register a callback fired when the user closes the overlay externally.
     * Returns an unsubscribe function — call it in useEffect cleanup.
     */
    onClosed(cb: () => void): () => void
  }

  desktop: {
    /** Enumerate all capturable screens and application windows. */
    getSources(): Promise<DesktopSourceInfo[]>
    /**
     * Pre-select which source getDisplayMedia() will use.
     * Awaitable — guarantees the selection is delivered to the main process
     * before the next getDisplayMedia() call is made.
     */
    setSource(id: string | null): Promise<void>
  }

  tray: {
    /** Toggle the tray icon between recording (red dot) and idle (grey dot). */
    setRecording(recording: boolean): void
    /** Tell the tray whether the running recording is paused (menu label). */
    setPaused(paused: boolean): void
  }

  app: {
    /**
     * Register a callback fired when the user confirmed "Stop & close" while a
     * recording is running. The callback must stop the recording, flush the
     * autosave and then call `readyToClose()` (main closes anyway after ~10 s).
     * Returns an unsubscribe function.
     */
    onStopAndClose(cb: () => void): () => void
    /** Signal that the recording is stopped and the project saved. */
    readyToClose(): void
    /**
     * A stopped take is (true) / is no longer (false) being finalized and
     * copied to the recordings folder. While true, closing the window waits
     * for it instead of cutting it off.
     */
    setSaving(saving: boolean): void
  }

  menu: {
    /**
     * Register a callback fired for each application-menu command.
     * The `id` matches the string passed to `webContents.send('menu:command', id)`
     * in main.cts (e.g. `'export'`, `'undo'`, `'toggle-library'`).
     * Returns an unsubscribe function — call it in useEffect cleanup.
     */
    onCommand(cb: (id: string) => void): () => void
    /**
     * Tell main the command handlers are installed; commands sent while the
     * window was still loading (e.g. tray "Start Recording") arrive now.
     */
    ready(): void
    /** The application menu as plain data, for the in-app menu bar. */
    getModel(): Promise<MenuModelItem[]>
    /** Activate the application-menu item at `path` (indices from getModel). */
    click(path: number[]): void
  }

  window: {
    /** Recolor the native caption buttons (Windows/Linux) to match the theme. */
    setTitleBarColors(colors: { color: string; symbolColor: string }): void
  }

  /**
   * Real files on the user's disk (the "recordings folder"), so recordings,
   * merged clips and imports survive the app's private storage (OPFS) being
   * cleared. The main process only writes inside the recordings folder, and
   * only reads files inside it or files registered via `registerImport`.
   */
  media: {
    /** Absolute path of the recordings folder (created if missing). */
    getFolder(): Promise<string>
    /** Let the user pick a new recordings folder; the new path, or null if canceled. */
    chooseFolder(): Promise<string | null>
    /** Show the folder — or, given a path inside it, that file — in Explorer/Finder. */
    reveal(absPath?: string): void
    /**
     * Start writing a new file at `relPath` under the recordings folder
     * (e.g. "My Project/2026-09-30 10.02 Screen.webm"). Unsafe characters are
     * replaced and name collisions get " (2)". Returns a write id and the
     * final absolute path.
     */
    openWrite(relPath: string): Promise<{ id: number; path: string }>
    /** Append bytes to an open write. */
    write(id: number, data: Uint8Array): Promise<void>
    /** Finish a write (flushes and closes the file). */
    closeWrite(id: number): Promise<void>
    /** Abandon a write and delete the partial file. */
    abortWrite(id: number): Promise<void>
    /** Size in bytes, or -1 if missing or not readable under the access rule. */
    stat(absPath: string): Promise<number>
    /** Read `length` bytes at `offset` (same access rule as stat). */
    read(absPath: string, offset: number, length: number): Promise<Uint8Array>
    /**
     * Absolute path of a File the user picked or dropped, and permission to
     * read it back later (persisted). '' when unavailable (e.g. a Blob).
     */
    registerImport(file: File): string
  }

  updates: {
    /** Subscribe to auto-update status. Returns an unsubscribe function. */
    onStatus(cb: (status: UpdateStatus) => void): () => void
    /** Check for an update now (also runs automatically after launch). */
    checkNow(): void
    /** Quit and install a downloaded update (refused by main while recording). */
    installAndRestart(): void
    /** Open the project's Releases page in the browser (fixed URL, set by main). */
    openReleasesPage(): void
  }

  diagnostics: {
    /** Append a renderer error to the local log file (and crash reporting, if enabled). */
    logError(message: string, detail?: string): void
    /** Open the folder with logs and crash dumps. */
    openLogsFolder(): void
  }
}
