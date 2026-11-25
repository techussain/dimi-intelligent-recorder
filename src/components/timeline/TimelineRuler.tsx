import { useEffect, useRef } from 'react'

/**
 * Time ruler. Only the visible slice is painted: the canvas is the width of
 * the scroll viewport and sticks to its left edge (a full-content-width canvas
 * exceeds the browser's max canvas size on long projects and renders blank).
 * Redraws on scroll / resize / zoom without going through React state.
 */
export function TimelineRuler({
  totalSec,
  zoom,
  height,
  scrollRef,
}: {
  totalSec: number
  zoom: number
  height: number
  /** The horizontally scrolling container the ruler lives in. */
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = ref.current
    const el = scrollRef.current
    if (!c || !el) return
    let raf = 0

    const draw = () => {
      raf = 0
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, el.clientWidth)
      const left = el.scrollLeft
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(height * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(height * dpr)
        c.style.width = `${w}px`
        c.style.height = `${height}px`
      }
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, height)
      ctx.fillStyle = '#9ca3af'
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'

      // Choose a sensible tick interval.
      const minPx = 80
      const intervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]
      let step = intervals[intervals.length - 1]!
      for (const i of intervals) {
        if (i * zoom >= minPx) {
          step = i
          break
        }
      }

      ctx.strokeStyle = '#2a2e36'
      ctx.lineWidth = 1
      // Integer tick index avoids float drift from repeated `t += step`.
      const first = Math.max(0, Math.floor(left / zoom / step))
      const last = Math.min(
        Math.floor(totalSec / step + 1e-6),
        Math.ceil((left + w) / zoom / step),
      )
      for (let i = first; i <= last; i++) {
        const t = i * step
        const x = Math.round(t * zoom - left) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, height - 8)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.fillText(fmtTime(t, step), x + 3, height - 10)
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }

    draw()
    el.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [totalSec, zoom, height, scrollRef])

  return <canvas ref={ref} className="block sticky left-0 pointer-events-none" />
}

/** Label for tick `sec`; decimals follow the tick spacing (0.25 s → 2). */
function fmtTime(sec: number, step: number): string {
  const decimals =
    step >= 1 ? 0 : Number.isInteger(Math.round(step * 1000) / 100) ? 1 : 2
  if (sec < 60) return `${sec.toFixed(decimals)}s`
  const m = Math.floor(sec / 60)
  const rest = sec - m * 60
  const s = decimals
    ? rest.toFixed(decimals).padStart(3 + decimals, '0')
    : String(Math.floor(rest + 1e-6)).padStart(2, '0')
  return `${m}:${s}`
}
