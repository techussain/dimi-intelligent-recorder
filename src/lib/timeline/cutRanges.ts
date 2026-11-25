/**
 * Ripple-cut time ranges out of the whole timeline, on every track at once,
 * so video, audio and captions stay in sync (used by silence removal).
 *
 * Pure: takes a (possibly frozen) project and returns a new one.
 */
import type { Clip, ID, Project } from './types'
import { splitKeyframes } from './keyframeSplit'
import { cloneEffects, effectsForCutSide } from '../effects/edit'

export interface TimeRange {
  start: number
  end: number
}

/** Sort, drop empty ranges, and merge overlapping/touching ones. */
export function normalizeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter(
      (r) =>
        Number.isFinite(r.start) && Number.isFinite(r.end) && r.end - r.start > 1e-6,
    )
    .map((r) => ({ start: Math.max(0, r.start), end: r.end }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

function durationOf(c: Clip): number {
  return Math.max(0, (c.sourceOut - c.sourceIn) / Math.max(0.1, c.speed || 1))
}

/** A fresh copy of a clip (no shared transform/color/crop/effect objects). */
function copyClip(c: Clip, patch: Partial<Clip>): Clip {
  const out: Clip = { ...c, transform: { ...c.transform }, ...patch }
  if (c.color) out.color = { ...c.color }
  if (c.crop) out.crop = { ...c.crop }
  if (c.effects) out.effects = cloneEffects(c.effects)
  return out
}

/**
 * A cut point isn't a real clip edge (the pieces play back to back after
 * the ripple), so drop the fade on that side — removing pauses must never
 * create dips. `side` is the piece's side of the cut.
 */
function dropCutFade(c: Clip, side: 'left' | 'right'): void {
  if (c.effects) c.effects = effectsForCutSide(c.effects, side)
}

/**
 * Tracks that would have to change (clips cut or shifted) but are locked.
 * The cut must apply to every track to keep sync, so callers refuse it.
 */
export function lockedTracksAffected(
  project: Project,
  ranges: readonly TimeRange[],
): string[] {
  const norm = normalizeRanges(ranges)
  const first = norm[0]
  if (!first) return []
  const names = new Set<string>()
  for (const t of project.tracks) {
    if (!t.locked) continue
    const touched = project.clips.some(
      (c) => c.trackId === t.id && c.timelineStart + durationOf(c) > first.start,
    )
    if (touched) names.add(t.name)
  }
  return [...names]
}

/**
 * Remove `ranges` (timeline seconds) from every track and close the gaps.
 * Clips inside a range are removed, clips spanning one are split, clips after
 * it move left. Markers inside a range are removed, later ones shift.
 * Transitions touching any cut clip are dropped. Live clips are left alone
 * (callers refuse while recording).
 */
export function cutTimeRanges(
  project: Project,
  ranges: readonly TimeRange[],
  newId: () => ID,
): Project {
  const norm = normalizeRanges(ranges)
  if (norm.length === 0) return project
  let clips: Clip[] = [...project.clips]
  let markers = project.markers ? [...project.markers] : undefined
  const touched = new Set<ID>()

  // Last range first, so earlier ranges' positions are still valid.
  for (const { start: a, end: b } of [...norm].reverse()) {
    const len = b - a
    const next: Clip[] = []
    for (const c of clips) {
      const s0 = c.timelineStart
      const e0 = s0 + durationOf(c)
      const sp = Math.max(0.1, c.speed || 1)
      if (c.isLive || e0 <= a + 1e-9) {
        next.push(c)
      } else if (s0 >= b - 1e-9) {
        next.push(copyClip(c, { timelineStart: s0 - len }))
      } else if (s0 >= a && e0 <= b) {
        touched.add(c.id) // fully inside: removed
      } else if (s0 < a && e0 > b) {
        // Spans the range: keep [s0,a] and [b,e0], joined at a.
        const left = copyClip(c, { sourceOut: c.sourceIn + (a - s0) * sp })
        const right = copyClip(c, {
          id: newId(),
          timelineStart: a,
          sourceIn: c.sourceIn + (b - s0) * sp,
        })
        if (c.keyframes) {
          left.keyframes = splitKeyframes(c.keyframes, a - s0).left
          right.keyframes = splitKeyframes(c.keyframes, b - s0).right
        }
        dropCutFade(left, 'left')
        dropCutFade(right, 'right')
        touched.add(c.id)
        next.push(left, right)
      } else if (s0 < a) {
        // Tail inside the range.
        const left = copyClip(c, { sourceOut: c.sourceIn + (a - s0) * sp })
        if (c.keyframes) left.keyframes = splitKeyframes(c.keyframes, a - s0).left
        dropCutFade(left, 'left')
        touched.add(c.id)
        next.push(left)
      } else {
        // Head inside the range.
        const cut = b - s0
        const right = copyClip(c, { timelineStart: a, sourceIn: c.sourceIn + cut * sp })
        if (c.keyframes) right.keyframes = splitKeyframes(c.keyframes, cut).right
        dropCutFade(right, 'right')
        touched.add(c.id)
        next.push(right)
      }
    }
    clips = next
    if (markers) {
      markers = markers
        .filter((m) => m.time < a || m.time >= b)
        .map((m) => (m.time >= b ? { ...m, time: m.time - len } : m))
    }
  }

  const duration = clips.reduce(
    (end, c) => Math.max(end, c.timelineStart + durationOf(c)),
    0,
  )
  const out: Project = {
    ...project,
    clips,
    transitions: project.transitions.filter(
      (t) => !touched.has(t.fromClipId) && !touched.has(t.toClipId),
    ),
    duration,
  }
  if (markers) out.markers = markers
  return out
}
