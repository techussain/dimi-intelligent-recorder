/**
 * Pure scheduling math for the export audio mix (kept free of Web Audio so it
 * can be unit tested). render.ts turns a plan into BufferSource + two chained
 * GainNodes: one for volume/keyframes, one for transition fades.
 */
import type { Clip, Project } from '../timeline/types'
import { sampleClipProp } from '../compositor/keyframes'
import { clipDuration, clipEnd, transitionWindow } from '../compositor/scene'
import { fadeGain } from '../effects/sample'
import { effectiveFade } from '../effects/timing'

/** One linear gain ramp: `v0` at `t0` → `v1` at `t1` (timeline seconds). */
export interface FadeSegment {
  t0: number
  v0: number
  t1: number
  v1: number
}

export interface ClipAudioPlan {
  /** Timeline time playback starts / stops. May extend past the clip edges
   *  into source handles so a crossfade can overlap on an adjacent join. */
  start: number
  stop: number
  /** Source offset (seconds) at `start`. */
  offset: number
  /** Transition fades, sorted by time. */
  fades: FadeSegment[]
  /**
   * The clip's Fade effect (timeline seconds) with edges owned by a
   * transition zeroed; null when no fade applies. Feed it to
   * sampleVolumeCurve.
   */
  edgeFade: { in: number; out: number } | null
}

/**
 * Plan playback of `clip` whose decoded audio lasts `sourceDuration` seconds.
 *
 * Crossfades use the same window as video — centred on the join. For
 * adjacent clips the outgoing clip keeps playing past its out-point and the
 * incoming one starts before its in-point, using source handles when the
 * media has them; where it doesn't, each side fades over the part of the
 * window it can cover, so the join never hard-cuts.
 */
export function planClipAudio(
  project: Project,
  clip: Clip,
  sourceDuration: number,
): ClipAudioPlan {
  const speed = Math.max(0.1, clip.speed ?? 1)
  let start = clip.timelineStart
  let stop = clipEnd(clip)
  const fades: FadeSegment[] = []

  for (const tr of project.transitions) {
    if (tr.kind !== 'crossfade' || tr.duration <= 0) continue
    if (tr.fromClipId === clip.id) {
      const other = project.clips.find((c) => c.id === tr.toClipId)
      if (!other) continue
      const win = transitionWindow(clip, other, tr.duration)
      const handle = Math.max(0, sourceDuration - clip.sourceOut) / speed
      const end = Math.min(win.end, clipEnd(clip) + handle)
      const t0 = Math.max(win.start, clip.timelineStart)
      if (end <= t0) continue
      stop = Math.max(stop, end)
      fades.push({ t0, v0: 1, t1: end, v1: 0 })
    } else if (tr.toClipId === clip.id) {
      const other = project.clips.find((c) => c.id === tr.fromClipId)
      if (!other) continue
      const win = transitionWindow(other, clip, tr.duration)
      const handle = Math.max(0, clip.sourceIn) / speed
      const begin = Math.max(0, win.start, clip.timelineStart - handle)
      const t1 = Math.min(win.end, clipEnd(clip))
      if (t1 <= begin) continue
      start = Math.min(start, begin)
      fades.push({ t0: begin, v0: 0, t1, v1: 1 })
    }
  }

  fades.sort((a, b) => a.t0 - b.t0)
  const offset = Math.max(0, clip.sourceIn - (clip.timelineStart - start) * speed)
  return { start, stop, offset, fades, edgeFade: effectiveFade(project, clip) }
}

/** Sample rate of the volume automation curve (points per second). */
export const VOLUME_CURVE_RATE = 100

/**
 * The clip's volume over timeline [start, stop], sampled with the same
 * keyframe math (and easing) as the preview mixer, times the clip's Fade
 * effect (`edgeFade`, see ClipAudioPlan). Returns null when the volume is
 * constant (no keyframes, no fade) — use `clip.volume` then.
 */
export function sampleVolumeCurve(
  clip: Clip,
  start: number,
  stop: number,
  rate = VOLUME_CURVE_RATE,
  edgeFade: { in: number; out: number } | null = null,
): Float32Array | null {
  const keys = clip.keyframes?.volume
  const hasKeys = !!keys && keys.length > 0
  if (!hasKeys && !edgeFade) return null
  const dur = clipDuration(clip)
  const n = Math.max(2, Math.ceil((stop - start) * rate) + 1)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = start + ((stop - start) * i) / (n - 1)
    // Keyframe t is clip-local timeline seconds (not divided by speed),
    // same axis as sampleClipProp everywhere else.
    const local = t - clip.timelineStart
    const vol = hasKeys
      ? sampleClipProp(clip, 'volume', local, clip.volume)
      : clip.volume
    out[i] = Math.max(0, vol * fadeGain(edgeFade, local, dur))
  }
  return out
}
