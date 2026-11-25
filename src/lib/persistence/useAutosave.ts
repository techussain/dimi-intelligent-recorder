import { useEffect, useRef } from 'react'
import { useEditor } from '../timeline/store'
import type { Project } from '../timeline/types'
import { saveCurrentProject, saveStoredProject, loadCurrentProject } from './project'
import { emitError } from '../errorBus'
import { checkProjectMedia } from '../storage/diskMedia'

/**
 * Debounced autosave: persists the current project to IndexedDB whenever it
 * changes. Also attempts a synchronous-ish save on tab hide / beforeunload.
 *
 * - While recording, the project changes on every chunk; instead of a save
 *   per chunk, a checkpoint is saved at most every RECORDING_CHECKPOINT_MS
 *   (throttled, not debounced), plus one when the recording stops. If the
 *   app dies mid-take, the checkpoint still holds the take's source and its
 *   live clip; loadProject + capture/recovery.ts finalize it on next open.
 * - When the open project is switched (newProject/loadProject), a pending
 *   save of the previous project is flushed immediately into its own slot,
 *   instead of being lost when the timer later reads the new state.
 * - Also on a switch (desktop app), media missing from OPFS is restored from
 *   the recordings folder / original files (see storage/diskMedia.ts).
 */
/** Max interval between autosaves while a take is recording. */
export const RECORDING_CHECKPOINT_MS = 5000

export function useAutosave(debounceMs = 800) {
  const timer = useRef<number | null>(null)
  const lastSaved = useRef<number>(0)
  /** Serializes writes so they land in call order (never an older state last). */
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    const enqueue = (write: () => Promise<void>) => {
      queue.current = queue.current.then(write).then(
        () => {
          lastSaved.current = Date.now()
        },
        (err: unknown) => {
          emitError('Autosave failed', err)
        },
      )
    }

    const doSave = () => {
      timer.current = null
      const st = useEditor.getState()
      // Only the `project` sub-tree is persisted. Ephemeral state
      // (selection, playhead, playing, zoom, recording, undo history, etc.)
      // lives on EditorState but is intentionally excluded here.
      const p = st.project
      enqueue(() => saveCurrentProject(p))
    }

    const schedule = (delay: number) => {
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(doSave, delay)
    }

    // Subscribe to project changes (and recording stop).
    const unsub = useEditor.subscribe((state, prev) => {
      if (state.project.id !== prev.project.id) {
        // Whatever path opened it (recent list, .irproj, bundle, menu): copy
        // media whose OPFS copy is gone back from disk (desktop app only;
        // once per opened project).
        void checkProjectMedia(state.project)
        // Project switch: flush the previous project's unsaved edits now.
        if (timer.current != null) {
          window.clearTimeout(timer.current)
          timer.current = null
          const old: Project = prev.project
          enqueue(() => saveStoredProject(old))
        }
        schedule(debounceMs)
        return
      }
      if (prev.recording.active && !state.recording.active) {
        schedule(0)
        return
      }
      if (state.project === prev.project) return
      if (state.recording.active) {
        // Throttle: keep a pending checkpoint instead of pushing it back on
        // every chunk (a debounce would never fire while recording).
        if (timer.current == null) schedule(RECORDING_CHECKPOINT_MS)
        return
      }
      schedule(debounceMs)
    })
    const flush = () => {
      void saveCurrentProject(useEditor.getState().project).catch((err: unknown) => {
        emitError('Autosave failed', err)
      })
    }
    const onHide = () => {
      // Only save when the page is actually being hidden, not on restore.
      if (document.visibilityState === 'hidden') flush()
    }
    // On a real close visibilityState is usually still 'visible', so the
    // unload path must save unconditionally.
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      unsub()
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onHide)
      if (timer.current != null) window.clearTimeout(timer.current)
    }
  }, [debounceMs])
}

/**
 * One-shot loader for startup. Resolves with true if a project was restored.
 */
export async function restoreLastProject(): Promise<boolean> {
  try {
    const p = await loadCurrentProject()
    if (!p) return false
    // Restore lost media BEFORE the preview first tries to read it.
    await checkProjectMedia(p)
    return useEditor.getState().loadProject(p)
  } catch (err) {
    emitError('Could not restore your last project', err)
    return false
  }
}
