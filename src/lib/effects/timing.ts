/**
 * Mapping between effect time bases and the timeline.
 *
 * Ranged effects (zoom / spotlight / shake) store SOURCE seconds; fades
 * store edge-relative TIMELINE seconds. These helpers convert for the UI
 * (timeline bars, inspector fields) and decide which fade edges apply.
 */
import type { Clip, Project } from '../timeline/types'
import { clipDuration, clipSourceTime } from '../compositor/scene'
import { activeFade, fadeEdges } from './sample'
import type { RangedEffect } from './types'

export { fadeEdges }

/** Timeline time at which `clip` shows source time `s` (unclamped). */
export function sourceToTimeline(clip: Clip, s: number): number {
  return clip.timelineStart + (s - clip.sourceIn) / Math.max(0.1, clip.speed || 1)
}

/** Source time shown by `clip` at timeline time `t`, clamped to its trim. */
export function timelineToSource(clip: Clip, t: number): number {
  return clipSourceTime(clip, t).time
}

/** Source time at timeline `t` without clamping (for drags / new effects). */
export function timelineToSourceRaw(clip: Clip, t: number): number {
  return clip.sourceIn + (t - clip.timelineStart) * Math.max(0.1, clip.speed || 1)
}

/**
 * The part of a ranged effect that is visible in the clip, in timeline
 * seconds, or null when it lies entirely outside the trimmed range.
 */
export function effectTimelineRange(
  clip: Clip,
  e: Pick<RangedEffect, 'start' | 'end'>,
): { start: number; end: number; clippedStart: boolean; clippedEnd: boolean } | null {
  const s = Math.max(e.start, clip.sourceIn)
  const en = Math.min(e.end, clip.sourceOut)
  if (en - s <= 1e-6) return null
  return {
    start: sourceToTimeline(clip, s),
    end: sourceToTimeline(clip, en),
    clippedStart: e.start < clip.sourceIn - 1e-6,
    clippedEnd: e.end > clip.sourceOut + 1e-6,
  }
}

/** The clip's effective fade (timeline seconds) after transition rules. */
export function effectiveFade(
  project: Pick<Project, 'transitions'>,
  clip: Clip,
): { in: number; out: number } | null {
  const f = activeFade(clip)
  if (!f) return null
  const edges = fadeEdges(project, clip.id)
  const res = { in: edges.fadeIn ? f.in : 0, out: edges.fadeOut ? f.out : 0 }
  if (res.in <= 0 && res.out <= 0) return null
  return res
}

/** Clip length in timeline seconds (re-exported for effect UIs). */
export { clipDuration }
