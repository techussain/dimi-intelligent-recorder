import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useEditor } from '../../lib/timeline/store'
import type { Clip } from '../../lib/timeline/types'
import type { SpotlightEffect, ZoomEffect } from '../../lib/effects/types'
import { clamp } from '../../lib/effects/easing'
import { useEffectAim } from '../../lib/effects/selection'

/** Normalized (u, v) in the layer's source for a pointer position. */
export type ToSourceUV = (clientX: number, clientY: number) => { u: number; v: number }

type Corner = 'nw' | 'ne' | 'se' | 'sw'
const CORNERS: { id: Corner; style: CSSProperties; cursor: string }[] = [
  { id: 'nw', style: { left: 0, top: 0 }, cursor: 'nwse-resize' },
  { id: 'ne', style: { left: '100%', top: 0 }, cursor: 'nesw-resize' },
  { id: 'se', style: { left: '100%', top: '100%' }, cursor: 'nwse-resize' },
  { id: 'sw', style: { left: 0, top: '100%' }, cursor: 'nesw-resize' },
]
const MIN_SPOT = 0.02

/** No text selection while dragging a handle. */
function setBodyUserSelect(v: string): void {
  document.body.style.userSelect = v
}

/**
 * Preview overlay for editing the selected zoom / spotlight.
 *
 * The preview normally shows the real result (zoomed / spotlit). Only while
 * the user presses and drags here (`aiming`) is the clip drawn without its
 * camera effects (drawScene `suppressEffects`), so the overlay box covers the
 * whole source and (u, v) map 1:1 onto it.
 *
 *  - zoom: drag to move the zoomed area (relative to where it is, so it never
 *    jumps); while dragging the whole frame shows with the zoom outline.
 *  - spotlight: drag the area to move it, its corners to resize; clicking
 *    elsewhere in the clip moves it there. When another camera effect (zoom,
 *    Ken Burns, shake) is cropping the picture at the playhead, the outline
 *    would not line up, so it only appears while dragging.
 *
 * Each drag is one undo step (begin/endInteraction).
 */
export function EffectHandles({
  clip,
  effect,
  boxStyle,
  toSourceUV,
  aligned,
  activeAtPlayhead,
  mirror = { x: false, y: false },
}: {
  clip: Clip
  effect: ZoomEffect | SpotlightEffect
  /** Positions the overlay exactly over the (rotated) layer box. */
  boxStyle: CSSProperties
  toSourceUV: ToSourceUV
  /** The rendered picture is not cropped by a camera effect at the playhead. */
  aligned: boolean
  /** The effect's time range covers the playhead. */
  activeAtPlayhead: boolean
  /**
   * The object is flipped: (u, v) stay in its own (unmirrored) coordinates,
   * so the outlines are drawn mirrored to line up with the picture.
   */
  mirror?: { x: boolean; y: boolean }
}) {
  // Display position of a span [p, p + size] along a (possibly mirrored) axis.
  const mx = (p: number, size = 0) => (mirror.x ? 1 - p - size : p)
  const my = (p: number, size = 0) => (mirror.y ? 1 - p - size : p)
  const updateEffect = useEditor((s) => s.updateEffect)
  const aiming = useEffectAim((s) => s.aiming)

  function drag(
    e: ReactPointerEvent<HTMLElement>,
    onMove: (uv: { u: number; v: number }, start: { u: number; v: number }) => void,
    applyAtStart: boolean,
  ) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const st = useEditor.getState()
    st.beginInteraction()
    useEffectAim.getState().setAiming(true)
    const start = toSourceUV(e.clientX, e.clientY)
    if (applyAtStart) onMove(start, start)
    let raf: number | null = null
    let last: { u: number; v: number } | null = null
    const flush = () => {
      raf = null
      if (last) onMove(last, start)
      last = null
    }
    const move = (ev: PointerEvent) => {
      last = toSourceUV(ev.clientX, ev.clientY)
      raf ??= requestAnimationFrame(flush)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (raf != null) cancelAnimationFrame(raf)
      flush()
      setBodyUserSelect('')
      useEditor.getState().endInteraction()
      useEffectAim.getState().setAiming(false)
    }
    setBodyUserSelect('none')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  if (effect.type === 'zoom') {
    const vw = 1 / effect.scale
    const left = clamp(effect.focusX - vw / 2, 0, 1 - vw)
    const top = clamp(effect.focusY - vw / 2, 0, 1 - vw)
    const fx0 = effect.focusX
    const fy0 = effect.focusY
    const what =
      effect.mode === 'grow'
        ? 'Grow'
        : effect.mode === 'frame'
          ? 'Whole-video zoom'
          : 'Zoom'
    const hint = aiming
      ? `${what} ${effect.scale.toFixed(2)}× · ${effect.mode === 'inside' ? 'release to see it' : 'dot = focus point'}`
      : activeAtPlayhead
        ? `${what} ${effect.scale.toFixed(2)}× · drag to move the focus`
        : `${what} ${effect.scale.toFixed(2)}× · move the playhead into the zoom to see it`
    return (
      <div
        className={'absolute ' + (aiming ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ ...boxStyle, touchAction: 'none' }}
        title="Drag to move the zoomed area"
        onPointerDown={(e) =>
          drag(
            e,
            ({ u, v }, s) =>
              updateEffect(clip.id, effect.id, {
                focusX: clamp(fx0 + (u - s.u), 0, 1),
                focusY: clamp(fy0 + (v - s.v), 0, 1),
              }),
            false,
          )
        }
      >
        {aiming && (
          <>
            <div className="absolute inset-0 border border-violet-400/70 pointer-events-none" />
            {/* The zoomed-area outline only applies to zooming INTO the picture. */}
            {effect.mode === 'inside' && (
              <div
                className="absolute border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)] pointer-events-none"
                style={{
                  left: `${mx(left, vw) * 100}%`,
                  top: `${my(top, vw) * 100}%`,
                  width: `${vw * 100}%`,
                  height: `${vw * 100}%`,
                }}
              />
            )}
            <div
              className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-violet-500 pointer-events-none"
              style={{
                left: `${mx(effect.focusX) * 100}%`,
                top: `${my(effect.focusY) * 100}%`,
              }}
            />
          </>
        )}
        <div className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white/85 pointer-events-none">
          {hint}
        </div>
      </div>
    )
  }

  const sp = effect
  const set = (r: { x: number; y: number; w: number; h: number }) =>
    updateEffect(clip.id, sp.id, r)

  const moveBy = (du: number, dv: number, x0: number, y0: number) =>
    set({
      x: clamp(x0 + du, 0, 1 - sp.w),
      y: clamp(y0 + dv, 0, 1 - sp.h),
      w: sp.w,
      h: sp.h,
    })

  const showOutline = aligned || aiming
  return (
    <div
      className="absolute cursor-crosshair"
      style={{ ...boxStyle, touchAction: 'none' }}
      title={
        showOutline ? 'Click to move the spotlight here' : 'Drag to move the spotlight'
      }
      onPointerDown={(e) => {
        if (!showOutline) {
          // Picture is cropped by another effect: positions wouldn't line
          // up, so move the area relative to where it is.
          const x0 = sp.x
          const y0 = sp.y
          drag(e, ({ u, v }, s) => moveBy(u - s.u, v - s.v, x0, y0), false)
          return
        }
        // Outside the area: centre it on the pointer, then keep dragging.
        const at = toSourceUV(e.clientX, e.clientY)
        const x0 = clamp(at.u - sp.w / 2, 0, 1 - sp.w)
        const y0 = clamp(at.v - sp.h / 2, 0, 1 - sp.h)
        drag(e, ({ u, v }, s) => moveBy(u - s.u, v - s.v, x0, y0), true)
      }}
    >
      {showOutline && (
        <div
          className={
            'absolute border-2 border-white/90 cursor-move ' +
            (sp.shape === 'ellipse' ? 'rounded-[50%]' : '')
          }
          style={{
            left: `${mx(sp.x, sp.w) * 100}%`,
            top: `${my(sp.y, sp.h) * 100}%`,
            width: `${sp.w * 100}%`,
            height: `${sp.h * 100}%`,
            boxShadow: '0 0 0 1px rgba(124,58,237,0.8)',
          }}
          onPointerDown={(e) => {
            const x0 = sp.x
            const y0 = sp.y
            drag(e, ({ u, v }, s) => moveBy(u - s.u, v - s.v, x0, y0), false)
          }}
        >
          {CORNERS.map((c) => (
            <div
              key={c.id}
              className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white/80 bg-accent"
              style={{ ...c.style, cursor: c.cursor }}
              onPointerDown={(e) => {
                // The opposite corner stays put (corners are visual; a
                // mirrored axis swaps them in the object's coordinates).
                const west = (c.id === 'nw' || c.id === 'sw') !== mirror.x
                const north = (c.id === 'nw' || c.id === 'ne') !== mirror.y
                const ax = west ? sp.x + sp.w : sp.x
                const ay = north ? sp.y + sp.h : sp.y
                drag(
                  e,
                  ({ u, v }) => {
                    const cu = clamp(u, 0, 1)
                    const cv = clamp(v, 0, 1)
                    const x = Math.min(ax, cu)
                    const y = Math.min(ay, cv)
                    set({
                      x,
                      y,
                      w: Math.max(MIN_SPOT, Math.abs(cu - ax)),
                      h: Math.max(MIN_SPOT, Math.abs(cv - ay)),
                    })
                  },
                  false,
                )
              }}
            />
          ))}
        </div>
      )}
      <div className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white/85 pointer-events-none">
        {!activeAtPlayhead
          ? 'Spotlight · move the playhead into it to see it'
          : showOutline
            ? 'Spotlight · drag to move, corners to resize'
            : 'Spotlight · drag to move'}
      </div>
    </div>
  )
}
