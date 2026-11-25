/**
 * Renderer side of the Electron close handshake.
 *
 * Main process (electron/main.cts) → 'app:stop-recording-and-close' when the
 * window closes while a take is recording (after the user confirmed "Stop &
 * close") or still being saved. We stop the capture, wait until every take
 * is finalized and copied to the recordings folder, flush the project to
 * IndexedDB, then reply with readyToClose(). Main gives up after a timeout
 * (long while we report saving via app.setSaving), so always reply — even on
 * failure.
 *
 * Call installElectronLifecycle() once at app startup. It is a no-op in a
 * plain browser and idempotent (safe under React StrictMode / HMR).
 */
import { getCaptureManager } from './capture/captureManager'
import { saveCurrentProject } from './persistence/project'
import { useEditor } from './timeline/store'

let uninstall: (() => void) | null = null

export function installElectronLifecycle(): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api) return () => {}
  if (uninstall) return uninstall

  const off = api.app.onStopAndClose(() => {
    void (async () => {
      const mgr = getCaptureManager()
      try {
        // Also sent while only saving (no take running): nothing to stop then.
        if (mgr.isRecording) await mgr.stop()
      } catch (err) {
        console.error('[lifecycle] stopping recording failed', err)
      }
      try {
        // Remux + copy to the recordings folder (the promised disk backup).
        await mgr.whenIdle()
      } catch (err) {
        console.error('[lifecycle] finishing the recording failed', err)
      }
      try {
        await saveCurrentProject(useEditor.getState().project)
      } catch (err) {
        console.error('[lifecycle] saving project failed', err)
      } finally {
        api.app.readyToClose()
      }
    })()
  })

  uninstall = () => {
    off()
    uninstall = null
  }
  return uninstall
}
