/**
 * Type declarations for the Electron context bridge APIs injected by
 * electron/preload.cts and electron/overlay-preload.cts.
 *
 * The canonical `ElectronAPI` interface lives in `src/lib/electronAPI.ts`.
 * Update that file when adding new IPC methods, then reference it here.
 */

// Augment React's CSSProperties with the Electron-specific drag region property.
import 'react'
declare module 'react' {
  interface CSSProperties {
    /** Electron: mark an element as a native window drag region. */
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}

export {}

/** A capturable screen or window, returned by electronAPI.desktop.getSources(). */
export interface DesktopSourceInfo {
  id: string
  name: string
  /** data-URL PNG thumbnail (320×180). */
  thumbnail: string
  /** data-URL app icon, or null for screen sources. */
  appIcon: string | null
}

import type { ElectronAPI } from './lib/electronAPI'

declare global {
  interface Window {
    /**
     * Injected by electron/preload.cts into the main renderer window.
     * Undefined when running in a plain browser.
     * Shape is defined in `src/lib/electronAPI.ts`.
     */
    electronAPI?: ElectronAPI

    /**
     * Injected by electron/overlay-preload.cts into the overlay window only.
     * Undefined everywhere else.
     */
    overlayAPI?: {
      /** Listen for param updates pushed from the main process. */
      onSetParams(cb: (params: { deviceId?: string; mirrored?: boolean }) => void): void
      /** Ask the main process to close this overlay window. */
      close(): void
      /** Ask the main process to enter or exit fullscreen. */
      setFullscreen(flag: boolean): void
      /** Register a callback fired when fullscreen state changes. */
      onFullscreenChange(cb: (isFullscreen: boolean) => void): void
    }
  }
}
