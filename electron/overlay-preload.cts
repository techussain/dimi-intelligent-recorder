import { contextBridge, ipcRenderer } from 'electron'

/**
 * Exposed on window.overlayAPI inside the floating webcam overlay window.
 */
contextBridge.exposeInMainWorld('overlayAPI', {
  onSetParams(cb: (params: { deviceId?: string; mirrored?: boolean }) => void) {
    // Replace any previously registered listener to avoid accumulation
    // across HMR reloads and React StrictMode double-invocations.
    ipcRenderer.removeAllListeners('overlay:set-params')
    ipcRenderer.on(
      'overlay:set-params',
      (
        _e: Electron.IpcRendererEvent,
        params: { deviceId?: string; mirrored?: boolean },
      ) => cb(params),
    )
  },

  close() {
    ipcRenderer.send('overlay:destroy')
  },

  setFullscreen(flag: boolean) {
    ipcRenderer.send('overlay:set-fullscreen', flag)
  },

  onFullscreenChange(cb: (isFullscreen: boolean) => void) {
    ipcRenderer.removeAllListeners('overlay:fullscreen-changed')
    ipcRenderer.on(
      'overlay:fullscreen-changed',
      (_e: Electron.IpcRendererEvent, flag: boolean) => cb(flag),
    )
  },
})
