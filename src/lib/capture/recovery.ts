/**
 * Crash recovery for takes that never stopped.
 *
 * While recording, autosave keeps checkpoints of the project (see
 * useAutosave), and every chunk is already flushed to the take's OPFS file.
 * If the app dies mid-take, the next loadProject of that project finds clips
 * still marked live and lists them as `interruptedTakes`. These are finalized
 * exactly like a normally stopped take: remux, correct the clip to the real
 * recorded length (the checkpoint only knew an earlier estimate) and copy the
 * file to the recordings folder.
 */
import { useEditor } from '../timeline/store'
import { getCaptureManager } from './captureManager'

/**
 * Finalize interrupted takes whenever a project that has some is loaded
 * (including one restored before this was installed). `onRecover` is told
 * how many recorded tracks are being recovered. Returns an uninstall function.
 */
export function installTakeRecovery(onRecover: (tracks: number) => void): () => void {
  const consume = () => {
    const pending = useEditor.getState().takeInterruptedTakes()
    if (!pending) return
    onRecover(pending.takes.length)
    void getCaptureManager().finalizeFiles(pending.takes, pending.projectId)
  }
  consume()
  return useEditor.subscribe((state, prev) => {
    if (state.interruptedTakes && state.interruptedTakes !== prev.interruptedTakes)
      consume()
  })
}
