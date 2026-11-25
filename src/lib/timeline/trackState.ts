import type { Project, Track } from './types'

/** True if any track has solo=true. */
export function anySolo(project: Project): boolean {
  return project.tracks.some((t) => t.solo)
}

/**
 * Returns true if the given track should be silenced for playback/export
 * (muted, or solo is active elsewhere and this track isn't soloed).
 */
export function isTrackSilenced(project: Project, track: Track): boolean {
  if (track.muted) return true
  if (anySolo(project) && !track.solo) return true
  return false
}

/**
 * Returns true if the given track should be hidden from visual output (video
 * only). Uses the explicit `hidden` flag; locked tracks are still rendered.
 */
export function isTrackHidden(_project: Project, track: Track): boolean {
  return !!track.hidden
}
