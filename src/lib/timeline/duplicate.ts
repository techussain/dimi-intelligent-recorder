/**
 * Fields for a duplicate of `clip` placed at `timelineStart` (the clip
 * context menu's "Duplicate"). Effects are source-time anchored, so they are
 * copied as is. The link group is not carried over.
 */
import type { Clip } from './types'
import { cloneEffects } from '../effects/edit'

export function duplicateClipData(clip: Clip, timelineStart: number): Omit<Clip, 'id'> {
  return {
    trackId: clip.trackId,
    sourceId: clip.sourceId,
    timelineStart,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    speed: clip.speed,
    volume: clip.volume,
    transform: { ...clip.transform },
    ...(clip.keyframes ? { keyframes: { ...clip.keyframes } } : {}),
    ...(clip.color ? { color: { ...clip.color } } : {}),
    ...(clip.crop ? { crop: { ...clip.crop } } : {}),
    ...(clip.effects ? { effects: cloneEffects(clip.effects) } : {}),
    ...(clip.loop !== undefined ? { loop: clip.loop } : {}),
    ...(clip.blendMode !== undefined ? { blendMode: clip.blendMode } : {}),
  }
}
