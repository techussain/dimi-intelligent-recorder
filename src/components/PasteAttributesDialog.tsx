import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useEditor } from '../lib/timeline/store'
import { useFocusTrap } from '../lib/ui/useFocusTrap'
import { useToast } from './ui/Toast'
import { PASTE_ATTRIBUTES_EVENT } from '../lib/layout/actions'
import { getInternalClipboard } from '../lib/timeline/clipboardEvents'
import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABELS,
  applicableAttributes,
  attributeSource,
  type AttributeSelection,
  type AttributeSource,
} from '../lib/timeline/clipboard'

/**
 * "Paste attributes…" (Ctrl+Alt+V, Ctrl+K, Edit menu): apply chosen
 * attributes of the first copied clip to every selected clip, one undo step.
 */
export function PasteAttributesDialog() {
  const [from, setFrom] = useState<AttributeSource | null>(null)
  const [sel, setSel] = useState<AttributeSelection | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const open = from !== null
  useFocusTrap(dialogRef, open)
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const targets = useMemo(
    () =>
      project.clips
        .filter((c) => selection.includes(c.id) && !c.isLive && c.id !== from?.clip.id)
        .map((clip) => ({
          clip,
          source: project.sources.find((s) => s.id === clip.sourceId),
        })),
    [project, selection, from],
  )
  const applicable = useMemo(
    () => (from ? applicableAttributes(from, targets) : null),
    [from, targets],
  )

  useEffect(() => {
    const onOpen = () => {
      const st = useEditor.getState()
      const payload = getInternalClipboard()
      const src = payload ? attributeSource(st.project, payload) : null
      if (!src) {
        toast.info('Nothing to paste', 'Copy a clip first (Ctrl+C).')
        return
      }
      if (st.selection.length === 0) {
        toast.info('Select the clips to paste attributes onto')
        return
      }
      setFrom(src)
      setSel(null)
    }
    window.addEventListener(PASTE_ATTRIBUTES_EVENT, onOpen)
    return () => window.removeEventListener(PASTE_ATTRIBUTES_EVENT, onOpen)
  }, [toast])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setFrom(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!from || !applicable) return null
  // Default: every applicable attribute ticked.
  const chosen: AttributeSelection = sel ?? applicable
  const effective = Object.fromEntries(
    ATTRIBUTE_KEYS.map((k) => [k, chosen[k] && applicable[k]]),
  ) as AttributeSelection
  const anyChosen = ATTRIBUTE_KEYS.some((k) => effective[k])

  function apply() {
    if (!from) return
    const n = useEditor.getState().pasteAttributes(
      from,
      effective,
      targets.map((t) => t.clip.id),
    )
    setFrom(null)
    if (n > 0)
      toast.success(
        n === 1 ? 'Attributes pasted' : `Attributes pasted to ${String(n)} clips`,
      )
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-6"
      onClick={() => setFrom(null)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-attrs-title"
        data-paste-attributes
        className="w-[360px] max-w-[92vw] rounded-xl border border-bd bg-elevated shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-bd">
          <h2 id="paste-attrs-title" className="text-sm font-semibold">
            Paste attributes
          </h2>
          <button
            type="button"
            className="p-1 rounded hover:bg-white/5 text-muted hover:text-fg"
            onClick={() => setFrom(null)}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-2 text-xs">
          <p className="text-muted text-[11px]">
            From “{from.source?.name ?? 'copied clip'}” to {targets.length} selected
            clip
            {targets.length === 1 ? '' : 's'}.
          </p>
          {ATTRIBUTE_KEYS.map((key) => (
            <label
              key={key}
              className={
                'flex items-center gap-2 ' +
                (applicable[key] ? 'text-fg' : 'text-muted/60 cursor-not-allowed')
              }
            >
              <input
                type="checkbox"
                data-attr={key}
                checked={effective[key]}
                disabled={!applicable[key]}
                onChange={(e) => {
                  const v = e.currentTarget.checked
                  setSel({ ...chosen, [key]: v })
                }}
              />
              {ATTRIBUTE_LABELS[key]}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-bd">
          <button type="button" className="btn-ghost" onClick={() => setFrom(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary disabled:opacity-40"
            data-paste-attributes-apply
            disabled={!anyChosen || targets.length === 0}
            onClick={apply}
          >
            Paste
          </button>
        </div>
      </div>
    </div>
  )
}
