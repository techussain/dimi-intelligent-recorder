import type { Clip, ID, MediaSource, Project } from './types'

/**
 * Source kinds that belong to one clip (duplicate / paste clone them): their
 * content — the words of a text, a shape's geometry, an element's params —
 * is part of the clip, so editing it is editing the clip. Media sources
 * (recordings, imports) are shared library items and may still be renamed.
 */
const PER_CLIP_SOURCE_KINDS: ReadonlySet<MediaSource['kind']> = new Set([
  'text',
  'shape',
  'element',
])

/** Ids of tracks that are locked. */
export function lockedTrackIds(project: Project): Set<ID> {
  return new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
}

/** True if `clip` sits on a locked track. */
export function isClipLocked(project: Project, clip: Clip): boolean {
  return project.tracks.some((t) => t.id === clip.trackId && t.locked)
}

/**
 * True if going from `before` to `after` adds, removes, changes or moves a
 * clip on a track that is locked in both states, or changes the per-clip
 * source (text, shape, element) of such a clip. Live (recording) clips are
 * exempt — they are managed by the capture pipeline.
 *
 * Relies on Immer's structural sharing: a clip the edit didn't touch keeps
 * its object identity, so `!==` means "changed".
 */
export function changesLockedClips(before: Project, after: Project): boolean {
  const lockedBefore = lockedTrackIds(before)
  if (lockedBefore.size === 0) return false
  const locked = new Set(
    [...lockedTrackIds(after)].filter((id) => lockedBefore.has(id)),
  )
  if (locked.size === 0) return false

  const beforeById = new Map(before.clips.map((c) => [c.id, c]))
  const afterById = new Map(after.clips.map((c) => [c.id, c]))

  // Removed, changed or moved out of a locked track.
  for (const c of before.clips) {
    if (c.isLive || !locked.has(c.trackId)) continue
    if (afterById.get(c.id) !== c) return true
  }
  // Added to, moved onto, or changed on a locked track.
  for (const c of after.clips) {
    if (c.isLive || !locked.has(c.trackId)) continue
    if (beforeById.get(c.id) !== c) return true
  }
  // The text / shape / element content of a locked clip was edited.
  if (before.sources !== after.sources) {
    const afterSources = new Map(after.sources.map((x) => [x.id, x]))
    for (const c of before.clips) {
      if (c.isLive || !locked.has(c.trackId)) continue
      const src = before.sources.find((x) => x.id === c.sourceId)
      if (
        src &&
        PER_CLIP_SOURCE_KINDS.has(src.kind) &&
        afterSources.get(src.id) !== src
      )
        return true
    }
  }
  return false
}
