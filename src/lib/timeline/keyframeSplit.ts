/**
 * Keyframe helpers shared by the store's split and the range-cut logic.
 */
import type { Clip, Keyframe, KeyframeProp } from './types'
import { ease as easeKf } from '../effects/easing'

/**
 * Value of a sorted keyframe list at clip-local `t`, plus the easing of the
 * segment `t` falls in (mirrors compositor/keyframes.ts sampleClipProp).
 */
function sampleKeyframes(
  list: Keyframe[],
  t: number,
): { value: number; easing?: Keyframe['easing'] } {
  const first = list[0]!
  const last = list[list.length - 1]!
  if (list.length === 1 || t <= first.t) return { value: first.value }
  if (t >= last.t) return { value: last.value }
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i]!
    const b = list[i + 1]!
    if (t >= a.t && t <= b.t) {
      const p = easeKf((t - a.t) / Math.max(1e-6, b.t - a.t), a.easing ?? 'linear')
      return a.easing
        ? { value: a.value + (b.value - a.value) * p, easing: a.easing }
        : { value: a.value + (b.value - a.value) * p }
    }
  }
  return { value: last.value }
}

type ClipKeyframes = NonNullable<Clip['keyframes']>

/**
 * Split clip-local keyframes at `cut` (clip-local seconds). Each half keeps
 * the keyframes on its side plus a boundary keyframe holding the value at the
 * cut, so the animation is continuous across the split. Right-half times are
 * re-based to start at 0. Returns fresh objects (no shared references).
 */
export function splitKeyframes(
  kfs: ClipKeyframes,
  cut: number,
): { left: ClipKeyframes; right: ClipKeyframes } {
  const tol = 1 / 240
  const left: ClipKeyframes = {}
  const right: ClipKeyframes = {}
  for (const prop of Object.keys(kfs) as KeyframeProp[]) {
    const list = [...(kfs[prop] ?? [])].sort((a, b) => a.t - b.t)
    if (list.length === 0) continue
    const at = sampleKeyframes(list, cut)
    const l: Keyframe[] = list.filter((k) => k.t < cut - tol).map((k) => ({ ...k }))
    l.push({ t: cut, value: at.value })
    const r: Keyframe[] = [
      at.easing
        ? { t: 0, value: at.value, easing: at.easing }
        : { t: 0, value: at.value },
    ]
    for (const k of list) if (k.t > cut + tol) r.push({ ...k, t: k.t - cut })
    left[prop] = l
    right[prop] = r
  }
  return { left, right }
}
