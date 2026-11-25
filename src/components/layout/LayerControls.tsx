import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  BringToFront,
  ChevronDown,
  SendToBack,
} from 'lucide-react'
import type { ID } from '../../lib/timeline/types'
import type { LayerDirection } from '../../lib/timeline/layerOrder'
import { ARRANGE_LABELS, arrangeSelection } from '../../lib/layout/actions'

const BTN =
  'h-6 inline-flex items-center justify-center rounded text-muted hover:text-fg hover:bg-white/5 disabled:opacity-35 disabled:pointer-events-none'

const HINTS: Record<LayerDirection, string> = {
  forward: 'Ctrl+]',
  backward: 'Ctrl+[',
  front: 'Ctrl+Shift+]',
  back: 'Ctrl+Shift+[',
}

/**
 * Bring forward / Send backward buttons plus a small menu for Bring to
 * front / Send to back (preview selection toolbar). One undo step each.
 */
export function LayerControls({ ids }: { ids: readonly ID[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const none = ids.length === 0

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (dir: LayerDirection) => {
    setOpen(false)
    arrangeSelection(dir, ids)
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-0.5">
      <button
        type="button"
        className={BTN + ' w-6'}
        disabled={none}
        title={`${ARRANGE_LABELS.forward} (${HINTS.forward})`}
        aria-label={ARRANGE_LABELS.forward}
        data-layer-action="forward"
        onClick={() => run('forward')}
      >
        <BringToFront size={14} />
      </button>
      <button
        type="button"
        className={BTN + ' w-6'}
        disabled={none}
        title={`${ARRANGE_LABELS.backward} (${HINTS.backward})`}
        aria-label={ARRANGE_LABELS.backward}
        data-layer-action="backward"
        onClick={() => run('backward')}
      >
        <SendToBack size={14} />
      </button>
      <button
        type="button"
        className={BTN + ' w-4'}
        disabled={none}
        title="More layer order"
        aria-label="More layer order"
        aria-haspopup="menu"
        aria-expanded={open}
        data-layer-action="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-1 z-30 min-w-[190px] rounded-lg border border-bd bg-elevated shadow-pop py-1 text-xs text-fg"
        >
          {(['front', 'back'] as const).map((dir) => {
            const Icon = dir === 'front' ? ArrowUpToLine : ArrowDownToLine
            return (
              <button
                key={dir}
                type="button"
                role="menuitem"
                data-layer-action={dir}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-white/5 text-left"
                onClick={() => run(dir)}
              >
                <Icon size={13} className="text-muted" aria-hidden />
                <span className="flex-1">{ARRANGE_LABELS[dir]}</span>
                <span className="text-[10px] text-muted font-mono">{HINTS[dir]}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
