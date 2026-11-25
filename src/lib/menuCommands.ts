/**
 * menuCommands.ts
 *
 * Maps application-menu command IDs (sent from main.cts via IPC) to the
 * corresponding renderer-side actions (Zustand store calls or custom events).
 *
 * Install once at app mount via `installMenuBridge()`.  The returned function
 * removes the IPC listener — use it as a useEffect cleanup.
 */

import { useEditor } from './timeline/store'
import { emitError } from './errorBus'
import { openProjectFromFile, saveProjectToFile } from './persistence/project'
import { PASTE_ATTRIBUTES_EVENT, arrangeSelection } from './layout/actions'

function dispatch(name: string) {
  window.dispatchEvent(new CustomEvent(name))
}

/** Run several store mutations as a single undo step. */
function grouped(fn: () => void) {
  const st = useEditor.getState()
  st.beginInteraction()
  try {
    fn()
  } finally {
    st.endInteraction()
  }
}

export function installMenuBridge(): () => void {
  if (!window.electronAPI?.menu) return () => {}

  const menu = window.electronAPI.menu
  const off = menu.onCommand((id) => {
    const st = useEditor.getState()

    switch (id) {
      // ── File ────────────────────────────────────────────────────────────
      case 'new-project':
        if (st.recording.active) {
          emitError('Stop the recording before starting a new project.')
          break
        }
        if (
          window.confirm(
            'Start a new project? Current work is autosaved and stays under Recent projects (Ctrl+K).',
          )
        ) {
          st.newProject()
        }
        break

      case 'open-project':
        if (st.recording.active) {
          emitError('Stop the recording before opening another project.')
          break
        }
        openProjectFromFile()
          .then((p) => {
            if (p) useEditor.getState().loadProject(p)
          })
          .catch((err: unknown) => {
            emitError(err instanceof Error ? err.message : 'Open failed', err)
          })
        break

      case 'save-project':
      case 'save-project-as':
        // saveProjectToFile always shows a Save As dialog.
        saveProjectToFile(st.project).catch((err: unknown) => {
          emitError(err instanceof Error ? err.message : 'Save failed', err)
        })
        break

      case 'import-media':
        dispatch('ir:import-media')
        break

      case 'export':
        dispatch('ir:open-export')
        break

      case 'open-recordings-folder':
        window.electronAPI?.media.reveal()
        break

      case 'media-folder-changed':
        // New recordings go to the new folder (main owns the setting);
        // existing diskPaths stay valid where they are.
        console.info('[menu] recordings folder changed')
        break

      // ── Edit ────────────────────────────────────────────────────────────
      case 'undo':
        st.undo()
        break

      case 'redo':
        st.redo()
        break

      case 'split-at-playhead':
        st.splitAt(st.playhead)
        break

      case 'add-marker':
        st.addMarker({ time: st.playhead, label: '' })
        break

      case 'delete-selected':
        grouped(() => {
          for (const clipId of st.selection) st.removeClip(clipId)
        })
        break

      case 'ripple-delete':
        grouped(() => {
          for (const clipId of st.selection) st.rippleDeleteClip(clipId)
        })
        break

      case 'select-all':
        st.setSelection(st.project.clips.map((c) => c.id))
        break

      case 'paste-attributes':
        dispatch(PASTE_ATTRIBUTES_EVENT)
        break

      case 'bring-forward':
        arrangeSelection('forward')
        break

      case 'send-backward':
        arrangeSelection('backward')
        break

      case 'bring-to-front':
        arrangeSelection('front')
        break

      case 'send-to-back':
        arrangeSelection('back')
        break

      // ── Recording ───────────────────────────────────────────────────────
      case 'start-recording':
        dispatch('ir:start-recording')
        break

      case 'stop-recording':
        dispatch('ir:stop-recording')
        break

      case 'pause-recording':
        dispatch('ir:toggle-pause')
        break

      case 'record-setup':
        dispatch('ir:open-record-setup')
        break

      // ── View ────────────────────────────────────────────────────────────
      case 'toggle-library':
        dispatch('ir:toggle-library')
        break

      case 'toggle-inspector':
        dispatch('ir:toggle-inspector')
        break

      case 'open-command-palette':
        dispatch('ir:open-command-palette')
        break

      case 'zoom-in':
        st.setZoom(st.zoom * 1.25)
        break

      case 'zoom-out':
        st.setZoom(st.zoom / 1.25)
        break

      case 'zoom-fit':
        dispatch('ir:zoom-fit')
        break

      // ── Help ────────────────────────────────────────────────────────────
      case 'show-shortcuts':
        dispatch('ir:toggle-help')
        break

      case 'about':
        dispatch('ir:show-about')
        break
    }
  })
  // Installed after the components' own listeners (parent effects run last):
  // commands main queued while the window was loading can be delivered now.
  menu.ready()
  return off
}
