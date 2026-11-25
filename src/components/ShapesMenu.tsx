import { useEffect, useRef, useState } from 'react'
import { Shapes } from 'lucide-react'
import { SHAPE_DRAG_MIME, SHAPE_LABELS, SHAPE_TYPES } from '../lib/shapes'
import { SHAPE_ICONS, addShapeAtPlayhead } from './shapeIcons'

/**
 * "Shapes" row of the Media Library's Elements tab: one button per shape,
 * click to add at the playhead or drag onto an overlay track.
 */
export function ShapesRow() {
  return (
    <div className="px-2 pt-2" data-shapes-row>
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted mb-1.5 px-0.5">
        Shapes
      </div>
      <div role="list" aria-label="Shapes" className="grid grid-cols-4 gap-1.5">
        {SHAPE_TYPES.map((type) => {
          const Icon = SHAPE_ICONS[type]
          return (
            <div role="listitem" key={type} className="min-w-0">
              <button
                type="button"
                draggable
                data-add-shape={type}
                onClick={() => addShapeAtPlayhead(type)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(SHAPE_DRAG_MIME, type)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                aria-label={`Add ${SHAPE_LABELS[type].toLowerCase()}`}
                title={`${SHAPE_LABELS[type]} — click to add at the playhead, or drag onto an overlay track`}
                className="w-full flex flex-col items-center gap-1 py-2 rounded-md border border-bd bg-surface2/60 text-muted transition-colors hover:border-accent/60 hover:bg-surface2 hover:text-fg cursor-grab active:cursor-grabbing"
              >
                <Icon size={18} aria-hidden />
                <span className="text-[10px] font-medium truncate max-w-full px-1">
                  {SHAPE_LABELS[type]}
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** "Shapes" dropdown in the preview's badge row (works with no selection). */
export function ShapesMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="px-2 py-0.5 rounded border inline-flex items-center gap-1 bg-surface2 border-bd hover:text-fg"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add a shape at the playhead"
        data-shapes-menu
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        <Shapes size={12} /> Shapes
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 mb-1 z-30 min-w-[160px] rounded-lg border border-bd bg-elevated shadow-pop py-1 font-sans text-xs text-fg"
        >
          {SHAPE_TYPES.map((type) => {
            const Icon = SHAPE_ICONS[type]
            return (
              <button
                key={type}
                type="button"
                role="menuitem"
                data-menu-shape={type}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-white/5 text-left"
                onClick={() => {
                  setOpen(false)
                  addShapeAtPlayhead(type)
                }}
              >
                <Icon size={13} className="text-muted" aria-hidden />
                {SHAPE_LABELS[type]}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
