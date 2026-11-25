import type { Clip, KeyframeProp } from '../timeline/types'
import { ease } from '../effects/easing'

export { ease }

/**
 * Sample a clip property value at master-timeline time `t`, honoring keyframes
 * when present. Returns the static base value when no keyframes are set.
 *
 * `clipLocal` is `t - clip.timelineStart` (seconds). Keyframe `t` values are
 * interpreted on the same clip-local axis.
 */
export function sampleClipProp(
  clip: Clip,
  prop: KeyframeProp,
  clipLocalT: number,
  fallback: number,
): number {
  const list = clip.keyframes?.[prop]
  if (!list || list.length === 0) return fallback
  if (list.length === 1) return list[0]!.value
  if (clipLocalT <= list[0]!.t) return list[0]!.value
  const last = list[list.length - 1]!
  if (clipLocalT >= last.t) return last.value
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i]!
    const b = list[i + 1]!
    if (clipLocalT >= a.t && clipLocalT <= b.t) {
      const span = Math.max(1e-6, b.t - a.t)
      const raw = (clipLocalT - a.t) / span
      const p = ease(raw, a.easing ?? 'linear')
      return a.value + (b.value - a.value) * p
    }
  }
  return fallback
}
