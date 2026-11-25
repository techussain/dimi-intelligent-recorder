/**
 * Pure helpers for editing a clip's effect list: copying on split / cut /
 * duplicate and the zoom-overlap rule. Used by the store and cutRanges.
 */
import type { ClipEffect, ZoomEffect } from './types'
import { MIN_EFFECT_LEN } from './types'

/** Deep copy (effects are flat objects). Ranged effects are source-time
 *  anchored, so a plain copy is right for split / cut / duplicate. */
export function cloneEffects(effects: readonly ClipEffect[]): ClipEffect[] {
  return effects.map((e) => ({ ...e }))
}

/**
 * Effects for one side of a cut. The cut point is not a real clip edge any
 * more (the halves play back to back), so the left side loses its fade-out
 * and the right side its fade-in — otherwise every split or removed pause
 * would dip to black. A fade with neither edge left is dropped.
 */
export function effectsForCutSide(
  effects: readonly ClipEffect[],
  side: 'left' | 'right',
): ClipEffect[] {
  const out: ClipEffect[] = []
  for (const e of effects) {
    if (e.type !== 'fade') {
      out.push({ ...e })
      continue
    }
    const f = side === 'left' ? { ...e, out: 0 } : { ...e, in: 0 }
    if (f.in > 0 || f.out > 0) out.push(f)
  }
  return out
}

/** Both sides of a split at one point. */
export function splitEffects(effects: readonly ClipEffect[]): {
  left: ClipEffect[]
  right: ClipEffect[]
} {
  return {
    left: effectsForCutSide(effects, 'left'),
    right: effectsForCutSide(effects, 'right'),
  }
}

/** True if two [start, end) ranges overlap (touching is fine). */
export function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  const eps = 1e-6
  return a.start < b.end - eps && b.start < a.end - eps
}

/** True if `zoom` overlaps another zoom in `effects` (itself excluded). */
export function zoomOverlaps(
  effects: readonly ClipEffect[],
  zoom: ZoomEffect,
): boolean {
  return effects.some(
    (e) => e.type === 'zoom' && e.id !== zoom.id && rangesOverlap(e, zoom),
  )
}

/**
 * The free source range around `at` between other zooms, or null if `at`
 * is inside one. Used to fit a new zoom ("Zoom here") and to clamp drags.
 */
export function freeZoomRange(
  effects: readonly ClipEffect[],
  at: number,
  excludeId?: string,
): { min: number; max: number } | null {
  let min = -Infinity
  let max = Infinity
  for (const e of effects) {
    if (e.type !== 'zoom' || e.id === excludeId) continue
    if (at >= e.start && at < e.end) return null
    if (e.end <= at + 1e-9) min = Math.max(min, e.end)
    else if (e.start >= at) max = Math.min(max, e.start)
  }
  if (max - min < MIN_EFFECT_LEN) return null
  return { min, max }
}
