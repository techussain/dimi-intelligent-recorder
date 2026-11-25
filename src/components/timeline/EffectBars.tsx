import { memo } from 'react'
import { useWindowListeners } from '../../lib/ui/useWindowListeners'
import { useEditor } from '../../lib/timeline/store'
import type { Clip } from '../../lib/timeline/types'
import {
  EFFECT_LABELS,
  isRangedEffect,
  MIN_EFFECT_LEN,
  type RangedEffect,
} from '../../lib/effects/types'
import { effectTimelineRange } from '../../lib/effects/timing'
import { isEffectSelected, useSelectedEffect } from '../../lib/effects/selection'

/** Pointer travel (px) before a bar mousedown becomes a drag. */
const DRAG_THRESHOLD_PX = 3
const LANE: Record<RangedEffect['type'], number> = { zoom: 0, spotlight: 1, shake: 2 }
const BAR_H = 4
const LANE_GAP = 1

type Mode = 'move' | 'start' | 'end'

/**
 * Thin purple bars along the bottom of a clip, one lane per effect type, for
 * the ranged effects (zoom / spotlight / shake). Click selects the effect;
 * drag moves it, edge-drag resizes it (one undo step per drag). Ranges are
 * source seconds, mapped through sourceIn / speed; an effect outside the
 * trimmed range is hidden (but kept).
 */
export const EffectBars = memo(function EffectBars({
  clip,
  zoom,
  locked,
}: {
  clip: Clip
  zoom: number
  locked: boolean
}) {
  const win = useWindowListeners()
  const selected = useSelectedEffect((s) => s.selected)
  const ranged = clip.effects?.filter(isRangedEffect) ?? []
  if (ranged.length === 0) return null

  function startDrag(ev: React.MouseEvent, e: RangedEffect, mode: Mode) {
    if (ev.button !== 0) return
    ev.stopPropagation()
    ev.preventDefault()
    const st = useEditor.getState()
    useSelectedEffect.getState().select({ clipId: clip.id, effectId: e.id })
    if (!st.selection.includes(clip.id)) st.setSelection([clip.id])
    const range = effectTimelineRange(clip, e)
    const editable = !locked && !clip.isLive
    const x0 = ev.clientX
    const speed = Math.max(0.1, clip.speed || 1)
    // Resize from the visible edge when the effect runs past the trim.
    const start0 = mode === 'start' ? Math.max(e.start, clip.sourceIn) : e.start
    const end0 = mode === 'end' ? Math.min(e.end, clip.sourceOut) : e.end
    // Zooms can't overlap: clamp to the neighbouring segments.
    let lo = 0
    let hi = Infinity
    if (e.type === 'zoom') {
      for (const o of clip.effects ?? []) {
        if (o.type !== 'zoom' || o.id === e.id) continue
        if (o.end <= e.start + 1e-9) lo = Math.max(lo, o.end)
        else if (o.start >= e.end - 1e-9) hi = Math.min(hi, o.start)
      }
    }
    // A moved bar stays at least partly inside the clip.
    const moveLo = Math.max(lo, Math.min(e.start, clip.sourceIn))
    const moveHi = Math.min(hi, Math.max(e.end, clip.sourceOut))
    let began = false

    const onMove = (m: MouseEvent) => {
      const dx = m.clientX - x0
      if (!began && Math.abs(dx) < DRAG_THRESHOLD_PX) return
      if (!editable) return
      if (!began) {
        useEditor.getState().beginInteraction()
        began = true
        document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize'
      }
      const ds = (dx / zoom) * speed
      let start = start0
      let end = end0
      if (mode === 'move') {
        const len = end0 - start0
        start = Math.min(Math.max(start0 + ds, moveLo), moveHi - len)
        end = start + len
      } else if (mode === 'start') {
        start = Math.min(Math.max(start0 + ds, lo), end0 - MIN_EFFECT_LEN)
      } else {
        end = Math.max(Math.min(end0 + ds, hi), start0 + MIN_EFFECT_LEN)
      }
      useEditor.getState().updateEffect(clip.id, e.id, { start, end })
    }
    const onUp = () => {
      win.off('mousemove', onMove)
      win.off('mouseup', onUp)
      document.body.style.cursor = ''
      if (began) {
        useEditor.getState().endInteraction()
        return
      }
      // Plain click: bring the playhead into the effect so it's visible.
      const now = useEditor.getState()
      if (range && (now.playhead < range.start || now.playhead >= range.end))
        now.setPlayhead(range.start)
    }
    win.on('mousemove', onMove)
    win.on('mouseup', onUp)
  }

  return (
    <>
      {ranged.map((e) => {
        const r = effectTimelineRange(clip, e)
        if (!r) return null
        const left = (r.start - clip.timelineStart) * zoom
        const width = Math.max(4, (r.end - r.start) * zoom)
        const lane = LANE[e.type]
        const isSel = isEffectSelected(selected, clip.id, e.id)
        return (
          <div
            key={e.id}
            data-effect-bar
            title={`${EFFECT_LABELS[e.type]} · ${(r.end - r.start).toFixed(2)}s${
              e.enabled ? '' : ' (off)'
            } — drag to move, drag edges to resize`}
            onMouseDown={(ev) => startDrag(ev, e, 'move')}
            className={
              'absolute z-20 rounded-sm cursor-grab ' +
              (isSel
                ? 'bg-violet-300 ring-1 ring-white/80'
                : 'bg-violet-500 hover:bg-violet-400') +
              (e.enabled ? '' : ' opacity-40')
            }
            style={{
              left,
              width,
              height: BAR_H,
              bottom: 2 + lane * (BAR_H + LANE_GAP),
            }}
          >
            {!r.clippedStart && (
              <div
                onMouseDown={(ev) => startDrag(ev, e, 'start')}
                className="absolute -left-0.5 -top-1 -bottom-1 w-1.5 cursor-ew-resize"
              />
            )}
            {!r.clippedEnd && (
              <div
                onMouseDown={(ev) => startDrag(ev, e, 'end')}
                className="absolute -right-0.5 -top-1 -bottom-1 w-1.5 cursor-ew-resize"
              />
            )}
          </div>
        )
      })}
    </>
  )
})
