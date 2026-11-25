import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  ELEMENT_DRAG_MIME,
  ELEMENT_TEMPLATES,
  drawElement,
  type ElementTemplate,
} from '../lib/elements'
import { ShapesRow } from './ShapesMenu'

interface ElementsPanelProps {
  /** Add an element of this template at the playhead. */
  onAdd(templateId: string): void
}

/** Seconds of empty canvas between loops of a card preview. */
const LOOP_GAP = 0.35
/** Card previews are tiny — 30 fps is plenty. */
const FRAME_MS = 1000 / 30

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** Draw one frame of `tpl`, fitted into the canvas with a little padding. */
function paint(canvas: HTMLCanvasElement, tpl: ElementTemplate, t: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cssW = canvas.clientWidth || 160
  const cssH = canvas.clientHeight || 100
  const w = Math.round(cssW * dpr)
  const h = Math.round(cssH * dpr)
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const pad = 8 * dpr
  const s = Math.min((w - pad * 2) / tpl.size.w, (h - pad * 2) / tpl.size.h)
  if (!(s > 0)) return
  ctx.translate(w / 2, h / 2)
  drawElement(ctx, tpl.id, null, t, tpl.defaultDuration, {
    w: tpl.size.w * s,
    h: tpl.size.h * s,
  })
}

function ElementCard({
  template,
  reducedMotion,
  onAdd,
}: {
  template: ElementTemplate
  reducedMotion: boolean
  onAdd(templateId: string): void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)

  // Only animate while the card is on screen.
  useEffect(() => {
    const el = canvasRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setVisible(e.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    // Slightly past the middle: every template shows its "hero" state there.
    const still = template.defaultDuration * 0.55
    // Static frame: off screen, reduced motion, and while fonts load.
    paint(el, template, still)
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (!cancelled && (!visible || reducedMotion)) paint(el, template, still)
    })
    if (!visible || reducedMotion) {
      return () => {
        cancelled = true
      }
    }
    const period = template.defaultDuration + LOOP_GAP
    let raf = 0
    let start = -1
    let last = -Infinity
    const tick = (now: number) => {
      // Begin at the poster frame so cards never flash empty when they appear.
      if (start < 0) start = now - still * 1000
      if (now - last >= FRAME_MS) {
        last = now
        paint(el, template, ((now - start) / 1000) % period)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [template, visible, reducedMotion])

  return (
    <button
      type="button"
      draggable
      onClick={() => onAdd(template.id)}
      onDragStart={(e) => {
        e.dataTransfer.setData(ELEMENT_DRAG_MIME, template.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      aria-label={`Add ${template.name}`}
      title={`${template.name} — click to add at the playhead, or drag onto the timeline`}
      className="group w-full flex flex-col text-left rounded-md border border-bd bg-surface2/60 overflow-hidden transition-colors hover:border-accent/60 hover:bg-surface2 cursor-grab active:cursor-grabbing"
    >
      <div
        className="relative w-full aspect-[16/10]"
        style={{
          background:
            'radial-gradient(120% 120% at 20% 0%, rgba(124,58,237,0.20), transparent 60%), linear-gradient(160deg, #262a35, #1a1d24)',
        }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full"
        />
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 w-5 h-5 rounded-md bg-accent text-white flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <Plus size={12} />
        </span>
      </div>
      <span className="px-2 py-1.5 text-[11px] font-medium text-fg truncate border-t border-bd">
        {template.name}
      </span>
    </button>
  )
}

/** Grid of animated element templates ("Elements" tab of the Media Library). */
export function ElementsPanel({ onAdd }: ElementsPanelProps) {
  const reducedMotion = usePrefersReducedMotion()
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-bd flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {ELEMENT_TEMPLATES.length} elements
        </span>
        <span className="text-[10px] text-muted">Click or drag to add</span>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        <ShapesRow />
        <div className="px-2.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
          Animated
        </div>
        <div
          role="list"
          aria-label="Animated elements"
          className="p-2 grid grid-cols-2 gap-2 content-start"
        >
          {ELEMENT_TEMPLATES.map((tpl) => (
            <div role="listitem" key={tpl.id} className="min-w-0">
              <ElementCard template={tpl} reducedMotion={reducedMotion} onAdd={onAdd} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
