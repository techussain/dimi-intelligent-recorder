/**
 * The DOM text measurer for layout/geometry: lays text out on a hidden 2D
 * canvas with the compositor's own `drawTextSource`, so selection boxes match
 * the rendered text exactly.
 */
import { drawTextSource } from '../compositor/textRender'
import type { TextMeasurer } from './geometry'

let measureCtx: CanvasRenderingContext2D | null | undefined

export const canvasTextMeasurer: TextMeasurer = (text, frameW, frameH, transform) => {
  if (typeof document === 'undefined') return null
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) return null
  return drawTextSource(measureCtx, text, frameW, frameH, transform)
}
