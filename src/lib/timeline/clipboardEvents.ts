/**
 * DOM wiring of the clip clipboard: `copy` / `cut` / `paste` events on the
 * document (keyboard shortcuts and the Electron Edit-menu roles both fire
 * them). Skipped inside text-entry controls, while a modal is open, and for
 * copy / cut while the page has a text selection, so normal text editing
 * keeps working.
 *
 * Copy writes the payload to an internal clipboard and, through the event's
 * DataTransfer, to the system clipboard (`application/x-dimi-clips` JSON +
 * a plain-text summary). Paste prefers the system clipboard's payload; it
 * falls back to the internal one only when the system clipboard still holds
 * our text (or no DataTransfer is available), so pasting after copying
 * something else elsewhere never inserts stale clips.
 */
import { useEditor } from './store'
import {
  CLIPS_MIME,
  buildClipboard,
  clipboardText,
  parseClipboard,
  type ClipboardPayload,
} from './clipboard'
import { isTextEntryTarget } from '../ui/keyTargets'

interface InternalClipboard {
  payload: ClipboardPayload
  text: string
}

let internal: InternalClipboard | null = null

/** The last clips copied in this window (null before the first copy). */
export function getInternalClipboard(): ClipboardPayload | null {
  return internal?.payload ?? null
}

/** Test hook. */
export function setInternalClipboard(payload: ClipboardPayload | null): void {
  internal = payload
    ? { payload, text: clipboardText(payload, useEditor.getState().project) }
    : null
}

/** A modal (help, command palette, export, paste attributes…) is open. */
function isModalOpen(): boolean {
  return (
    typeof document !== 'undefined' &&
    !!document.querySelector('[role="dialog"][aria-modal="true"]')
  )
}

function hasTextSelection(): boolean {
  const sel = typeof document !== 'undefined' ? document.getSelection() : null
  return !!sel && !sel.isCollapsed && sel.toString().length > 0
}

/**
 * Copy the selected clips. Writes to `dt` when given (a copy / cut event's
 * clipboardData). Returns the payload, or null when nothing is selected.
 */
export function copySelection(dt: DataTransfer | null): ClipboardPayload | null {
  const st = useEditor.getState()
  const payload = buildClipboard(st.project, st.selection)
  if (!payload) return null
  const text = clipboardText(payload, st.project)
  internal = { payload, text }
  if (dt) {
    try {
      dt.setData(CLIPS_MIME, JSON.stringify(payload))
      dt.setData('text/plain', text)
    } catch {
      // Read-only DataTransfer: the internal clipboard still works.
    }
  }
  return payload
}

/** Copy + delete the selected clips (the delete is one undo step). */
export function cutSelection(dt: DataTransfer | null): ClipboardPayload | null {
  const payload = copySelection(dt)
  if (!payload) return null
  useEditor.getState().removeClips(payload.clips.map((c) => c.id))
  return payload
}

/** The payload a paste with `dt` should insert (see the header). */
export function payloadForPaste(dt: DataTransfer | null): ClipboardPayload | null {
  if (dt && Array.from(dt.types).includes(CLIPS_MIME)) {
    const parsed = parseClipboard(dt.getData(CLIPS_MIME))
    if (parsed) return parsed
  }
  if (!internal) return null
  if (!dt || dt.types.length === 0) return internal.payload
  return dt.getData('text/plain') === internal.text ? internal.payload : null
}

export interface PasteResult {
  ids: string[]
  skipped: number
}

/** Paste at the playhead. Null when there is nothing to paste. */
export function pasteClipboard(dt: DataTransfer | null): PasteResult | null {
  const payload = payloadForPaste(dt)
  if (!payload) return null
  return useEditor.getState().pasteClips(payload)
}

export interface ClipboardHandlerOptions {
  /** Called after a paste (e.g. to report skipped clips). */
  onPaste?: (result: PasteResult) => void
  onCut?: (count: number) => void
}

/** Install the document-level handlers. Returns the uninstaller. */
export function installClipboardHandlers(
  opts: ClipboardHandlerOptions = {},
): () => void {
  const skip = (e: ClipboardEvent) =>
    e.defaultPrevented || isTextEntryTarget(e.target) || isModalOpen()
  const onCopy = (e: ClipboardEvent) => {
    if (skip(e) || hasTextSelection()) return
    if (copySelection(e.clipboardData)) e.preventDefault()
  }
  const onCut = (e: ClipboardEvent) => {
    if (skip(e) || hasTextSelection()) return
    const payload = cutSelection(e.clipboardData)
    if (!payload) return
    e.preventDefault()
    opts.onCut?.(payload.clips.length)
  }
  const onPaste = (e: ClipboardEvent) => {
    if (skip(e)) return
    const payload = payloadForPaste(e.clipboardData)
    if (!payload) return
    e.preventDefault()
    const result = useEditor.getState().pasteClips(payload)
    opts.onPaste?.(result)
  }
  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCut)
  document.addEventListener('paste', onPaste)
  return () => {
    document.removeEventListener('copy', onCopy)
    document.removeEventListener('cut', onCut)
    document.removeEventListener('paste', onPaste)
  }
}

/**
 * Copy (or cut) from a command rather than a clipboard event (Ctrl+K): the
 * internal clipboard plus, best effort, the text summary on the system
 * clipboard so a later Ctrl+V still recognises it. Returns the clip count.
 */
export function copyFromCommand(cut = false): number {
  const payload = cut ? cutSelection(null) : copySelection(null)
  if (!payload) return 0
  const text = internal?.text
  if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {})
  }
  return payload.clips.length
}
