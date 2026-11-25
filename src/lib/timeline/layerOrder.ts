/**
 * Layer order (Bring forward / Send backward / to front / to back).
 *
 * Z-order is track order (track[0] paints on top) and a track shows one clip
 * at a time, so changing an object's layer means moving its clip to another
 * track over the same time range. The rules:
 *
 *  - Only visual clips (video / overlay tracks) move, never live ones.
 *  - "Blockers" are the other (unselected) clips on visual tracks that
 *    overlap the clip in time: those are what it is drawn above / below.
 *  - forward: lands directly above the nearest blocker above it (one step);
 *    front: above the topmost blocker; backward / back: mirror images.
 *    No blocker in that direction = already there, nothing changes.
 *  - Target track: an existing track between the blocker and the next one in
 *    that direction, of the SAME kind as the clip's track (an overlay never
 *    becomes a full-frame main-track picture and vice versa), unlocked,
 *    compatible with the source, without a built-in recording role, and free
 *    for the clip's time range. Otherwise a new track of that kind is
 *    inserted right next to the blocker.
 *  - The main screen track is a floor: built-in recording tracks are never a
 *    target (so nothing is ever moved onto the screen recording), and an
 *    object above the screen track is never sent below it (blockers at or
 *    under the screen track are ignored), so "Send to back" puts it just
 *    above the screen recording instead of hiding it underneath.
 *  - Several clips: processed nearest-first in the direction of travel
 *    (topmost first going up), with selected clips never blocking each
 *    other, so their relative order is kept.
 *
 * Pure: mutates the given project (an Immer draft in the store).
 */
import { isSourceCompatible, isVisualTrackKind } from './compat'
import type { Clip, ID, Project, Track } from './types'

export type LayerDirection = 'forward' | 'backward' | 'front' | 'back'

function clipEndOf(c: Clip): number {
  return (
    c.timelineStart +
    Math.max(0, (c.sourceOut - c.sourceIn) / Math.max(0.1, c.speed || 1))
  )
}

function overlaps(a: Clip, b: Clip): boolean {
  return a.timelineStart < clipEndOf(b) && clipEndOf(a) > b.timelineStart
}

/** Track `trackId` has no clip (other than `self`) overlapping `self` in time. */
function isFree(project: Project, trackId: ID, self: Clip): boolean {
  return !project.clips.some(
    (c) => c.id !== self.id && c.trackId === trackId && overlaps(c, self),
  )
}

function newTrack(kind: Track['kind'], id: ID): Track {
  return {
    id,
    kind,
    name: kind === 'video' ? 'Video' : 'Overlay',
    muted: false,
    locked: false,
    height: kind === 'video' ? 72 : 56,
  }
}

/**
 * Move one clip a layer step. Returns true when it moved. `exclude` = clips
 * that never block (the rest of the selection).
 */
function reorderOne(
  project: Project,
  clip: Clip,
  dir: LayerDirection,
  exclude: ReadonlySet<ID>,
  makeId: () => ID,
): boolean {
  const tracks = project.tracks
  const cur = tracks.findIndex((t) => t.id === clip.trackId)
  const track = tracks[cur]
  if (!track || !isVisualTrackKind(track.kind)) return false
  const source = project.sources.find((s) => s.id === clip.sourceId)
  if (!source || source.kind === 'audio') return false
  const up = dir === 'forward' || dir === 'front'

  // The screen track is a floor for objects above it.
  const screenIdx = tracks.findIndex((t) => t.role === 'screen')
  const floor = screenIdx > cur ? screenIdx : tracks.length

  // Indices of tracks holding a blocker, in the direction of travel.
  const blockerIdx: number[] = []
  const range = up
    ? Array.from({ length: cur }, (_, i) => cur - 1 - i)
    : Array.from({ length: Math.max(0, floor - cur - 1) }, (_, i) => cur + 1 + i)
  for (const i of range) {
    const t = tracks[i]
    if (!t || !isVisualTrackKind(t.kind)) continue
    const blocked = project.clips.some(
      (c) =>
        c.trackId === t.id &&
        c.id !== clip.id &&
        !exclude.has(c.id) &&
        overlaps(c, clip),
    )
    if (blocked) blockerIdx.push(i)
  }
  const step = dir === 'forward' || dir === 'backward'
  const blocker = step ? blockerIdx[0] : blockerIdx[blockerIdx.length - 1]
  if (blocker === undefined) return false
  const next = step ? blockerIdx[1] : undefined

  const eligible = (t: Track | undefined): t is Track =>
    !!t &&
    t.kind === track.kind &&
    !t.locked &&
    !t.role &&
    isSourceCompatible(t.kind, source.kind) &&
    isFree(project, t.id, clip)

  let target: Track | undefined
  if (up) {
    // Nearest to the blocker, above it, below the next blocker.
    const stop = next ?? -1
    for (let i = blocker - 1; i > stop; i--) {
      if (eligible(tracks[i])) {
        target = tracks[i]
        break
      }
    }
  } else {
    const stop = next ?? floor
    for (let i = blocker + 1; i < stop; i++) {
      if (eligible(tracks[i])) {
        target = tracks[i]
        break
      }
    }
  }
  if (!target) {
    target = newTrack(track.kind, makeId())
    tracks.splice(up ? blocker : blocker + 1, 0, target)
  }
  clip.trackId = target.id
  return true
}

/**
 * Move `ids` (visual, non-live clips) one layer step / to the front or back
 * (see the rules above). Returns how many clips moved.
 */
export function reorderClipsIn(
  project: Project,
  ids: readonly ID[],
  dir: LayerDirection,
  makeId: () => ID,
): number {
  const idSet = new Set(ids)
  const trackIndex = (c: Clip) => project.tracks.findIndex((t) => t.id === c.trackId)
  const up = dir === 'forward' || dir === 'front'
  const clips = project.clips
    .filter((c) => idSet.has(c.id) && !c.isLive)
    // Topmost first going up, bottom-most first going down.
    .sort((a, b) =>
      up ? trackIndex(a) - trackIndex(b) : trackIndex(b) - trackIndex(a),
    )
  let moved = 0
  for (const c of clips) {
    if (reorderOne(project, c, dir, idSet, makeId)) moved++
  }
  return moved
}
