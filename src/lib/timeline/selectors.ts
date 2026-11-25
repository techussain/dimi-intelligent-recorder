import type { Clip, ID, Project } from './types'

export function clipDurationSec(c: Clip): number {
  return Math.max(0, (c.sourceOut - c.sourceIn) / Math.max(0.1, c.speed ?? 1))
}

export function clipEndSec(c: Clip): number {
  return c.timelineStart + clipDurationSec(c)
}

/** All clips live at the given timeline time (across all tracks). */
export function clipsAt(project: Project, time: number): Clip[] {
  return project.clips.filter((c) => time >= c.timelineStart && time < clipEndSec(c))
}

/** The topmost active clip on the given track at the given time, if any. */
export function activeAt(
  project: Project,
  time: number,
  trackId: ID,
): Clip | undefined {
  let best: Clip | undefined
  for (const c of project.clips) {
    if (c.trackId !== trackId) continue
    if (time < c.timelineStart || time >= clipEndSec(c)) continue
    if (!best || c.timelineStart > best.timelineStart) best = c
  }
  return best
}

/**
 * THE rule for which clip on a track is on top at time `t` — shared by the
 * compositor, mixer, export and UI so they never disagree:
 *   - only clips covering `t` (start inclusive, end exclusive) are candidates;
 *   - live (still-recording) clips are skipped unless `includeLive` is set, so
 *     a take in progress never hides the clip underneath it;
 *   - the latest-starting clip wins; ties go to the clip later in
 *     `project.clips` (added/split last).
 * Track hidden/muted/solo state is NOT considered — callers apply that
 * (hidden tracks still play audio; muted tracks still draw).
 */
export function topClipAt(
  project: Project,
  trackId: ID,
  t: number,
  opts: { includeLive?: boolean } = {},
): Clip | undefined {
  let best: Clip | undefined
  for (const c of project.clips) {
    if (c.trackId !== trackId) continue
    if (c.isLive && !opts.includeLive) continue
    if (t < c.timelineStart || t >= clipEndSec(c)) continue
    if (!best || c.timelineStart >= best.timelineStart) best = c
  }
  return best
}

// ---------- time math ----------

export function secToFrames(sec: number, fps: number): number {
  return Math.round(sec * fps)
}

export function framesToSec(frames: number, fps: number): number {
  return frames / fps
}

/** Snap `t` to the nearest multiple of `grid` (seconds). 0 disables. */
export function snapToGrid(t: number, grid: number): number {
  if (grid <= 0) return t
  return Math.round(t / grid) * grid
}

/** Snap `t` to the nearest salient edge from `candidates`, within `threshold` sec. */
export function snapToEdges(
  t: number,
  candidates: number[],
  threshold: number,
): number {
  let best = t
  let bestDist = threshold
  for (const c of candidates) {
    const d = Math.abs(t - c)
    if (d <= bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

/** Collect all salient edges for snapping (clip starts/ends, playhead, markers). */
export function salientEdges(project: Project, extras: number[] = []): number[] {
  const xs: number[] = [0, ...extras]
  for (const c of project.clips) {
    xs.push(c.timelineStart)
    xs.push(clipEndSec(c))
  }
  return xs
}
