/**
 * Chroma key as a drawScene `processImage` hook (preview + export): layers
 * whose clip has an enabled chroma-key effect are keyed through one shared
 * ChromaKeyProcessor; everything else is drawn unchanged.
 */
import { effectAllowedFor } from '../effects/types'
import type { ChromaSample } from '../effects/sample'
import type { Clip, MediaSource } from '../timeline/types'
import type { ChromaKeyProcessor } from './chromaKey'
import { mediaSize, type SceneImage, type SceneLayer } from './scene'

/** The chroma-key parameters to apply to a layer, or null for none. */
export function layerChroma(layer: {
  clip: Pick<Clip, 'effects'>
  source: Pick<MediaSource, 'kind'>
}): ChromaSample | null {
  if (!effectAllowedFor('chromaKey', layer.source.kind)) return null
  if (layer.source.kind !== 'video' && layer.source.kind !== 'animation') return null
  for (const e of layer.clip.effects ?? []) {
    if (e.type === 'chromaKey' && e.enabled) {
      return {
        color: e.color,
        similarity: e.similarity,
        smoothness: e.smoothness,
        spill: e.spill,
      }
    }
  }
  return null
}

/**
 * A `processImage` hook. `getProcessor` is called lazily (only once a keyed
 * layer is drawn) so projects without chroma key never create a GL context.
 * The processor's output canvas is shared: drawScene draws it right away.
 */
export function chromaProcessImage(
  getProcessor: () => ChromaKeyProcessor | null,
): (layer: SceneLayer, el: SceneImage) => SceneImage {
  return (layer, el) => {
    const params = layerChroma(layer)
    if (!params) return el
    const proc = getProcessor()
    if (!proc) return el
    const { w, h } = mediaSize(el)
    if (!w || !h) return el
    return proc.process(el, params, w, h) ?? el
  }
}
