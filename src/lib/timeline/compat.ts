/**
 * Which source kinds may sit on which track kinds (timeline drops, clip
 * moves, layer order, paste). Main video tracks take pictures only; overlay
 * tracks also take text, animations, elements and shapes.
 */
import type { MediaSource, TrackKind } from './types'

export function isSourceCompatible(
  kind: TrackKind,
  srcKind: MediaSource['kind'],
): boolean {
  if (kind === 'video') return srcKind === 'video' || srcKind === 'image'
  if (kind === 'audio') return srcKind === 'audio'
  if (kind === 'overlay')
    return (
      srcKind === 'video' ||
      srcKind === 'image' ||
      srcKind === 'text' ||
      srcKind === 'animation' ||
      srcKind === 'element' ||
      srcKind === 'shape'
    )
  return false
}

/** Video and overlay tracks draw pictures (z-order = track order). */
export function isVisualTrackKind(kind: TrackKind): boolean {
  return kind === 'video' || kind === 'overlay'
}
