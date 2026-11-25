import type { MediaSource } from '../timeline/types'
import { ELEMENT_FONT_FAMILY } from '../elements'
import {
  fontShorthand,
  resolveTextStyle,
  type ResolvedTextStyle,
  type RichTextStyle,
} from '../text/style'
import {
  defaultBaseline,
  layoutText,
  underlineRect,
  type MeasureFn,
  type TextLayout,
} from '../text/layout'

export interface TextRenderTransform {
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  rotation?: number
}

export interface TextBoxRect {
  x: number
  y: number
  w: number
  h: number
}

type LetterSpacingCtx = CanvasRenderingContext2D & { letterSpacing?: string }

/**
 * Set the font + letter spacing on `ctx` and return a measure function in
 * the layout's contract (advance incl. spacing after every glyph). Where the
 * canvas has no `letterSpacing` (not Chromium), spacing is added per glyph
 * to the measurement only.
 */
function prepareFont(
  ctx: CanvasRenderingContext2D,
  font: string,
  spacingPx: number,
): MeasureFn {
  ctx.font = font
  const lsCtx = ctx as LetterSpacingCtx
  const native = typeof lsCtx.letterSpacing === 'string'
  if (native) lsCtx.letterSpacing = `${String(spacingPx)}px`
  if (native || spacingPx === 0) return (s) => ctx.measureText(s).width
  return (s) => ctx.measureText(s).width + spacingPx * Array.from(s).length
}

/** Distance from the 'middle' baseline down to the alphabetic baseline. */
function middleToBaseline(ctx: CanvasRenderingContext2D, fontSize: number): number {
  const m = ctx.measureText('x')
  // With textBaseline 'middle', alphabeticBaseline is the (signed) offset of
  // the alphabetic baseline from the middle line; Chromium reports it as a
  // negative number when the baseline lies below.
  const v = m.alphabeticBaseline
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return Math.abs(v)
  return defaultBaseline(fontSize)
}

function boxPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  if (r <= 0) {
    ctx.rect(x, y, w, h)
  } else if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
  } else {
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }
}

/** Set up `ctx` (font, letter spacing, baseline) for `style` and lay it out. */
function layoutOnContext(
  ctx: CanvasRenderingContext2D,
  style: ResolvedTextStyle,
): TextLayout {
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const measure = prepareFont(
    ctx,
    fontShorthand(style),
    style.letterSpacing * style.fontSize,
  )
  return layoutText(style, measure)
}

/**
 * Lay a text style out with `ctx`'s text metrics, without drawing (the
 * context state is restored). Sizes are unscaled project px.
 */
export function measureTextLayout(
  ctx: CanvasRenderingContext2D,
  text: RichTextStyle,
): TextLayout {
  ctx.save()
  try {
    return layoutOnContext(ctx, resolveTextStyle(text))
  } finally {
    ctx.restore()
  }
}

/**
 * Render a text source into the canvas, centred on the frame (+ transform
 * x/y). fontSize, strokeWidth, boxWidth, paddings and transform x/y are in
 * PROJECT pixels: callers pass the project size as `canvasWidth` /
 * `canvasHeight` and scale the context to the output resolution (see
 * compositor/scene.ts), so text keeps the same relative size in preview and
 * at every export resolution.
 *
 * `pxScale` is that context scale (output px per project px). Shadow blur and
 * offset ignore the context transform, so they're scaled explicitly (by the
 * clip scale too).
 *
 * Returns the drawn box (text area + background padding), centred on the
 * anchor and scaled by the transform scale. The shadow isn't included.
 */
export function drawTextSource(
  ctx: CanvasRenderingContext2D,
  text: RichTextStyle,
  canvasWidth: number,
  canvasHeight: number,
  transform: TextRenderTransform = {},
  pxScale = 1,
): TextBoxRect {
  const tx = transform.x ?? 0
  const ty = transform.y ?? 0
  const scaleX = transform.scaleX ?? 1
  const scaleY = transform.scaleY ?? 1
  const rotation = transform.rotation ?? 0
  const style = resolveTextStyle(text)
  const size = style.fontSize
  const cx = canvasWidth / 2 + tx
  const cy = canvasHeight / 2 + ty

  ctx.save()
  const layout = layoutOnContext(ctx, style)

  ctx.translate(cx, cy)
  if (rotation) ctx.rotate((rotation * Math.PI) / 180)
  if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY)

  if (style.background) {
    const prevAlpha = ctx.globalAlpha
    ctx.globalAlpha = prevAlpha * style.backgroundOpacity
    ctx.fillStyle = style.background
    boxPath(
      ctx,
      -layout.width / 2,
      -layout.height / 2,
      layout.width,
      layout.height,
      style.backgroundRadius,
    )
    ctx.fill()
    ctx.globalAlpha = prevAlpha
  }

  if (style.shadow) {
    const k = pxScale * Math.sqrt(Math.abs(scaleX * scaleY))
    ctx.shadowColor = style.shadowColor
    ctx.shadowBlur = style.shadowBlur * k
    ctx.shadowOffsetX = style.shadowOffsetX * k
    ctx.shadowOffsetY = style.shadowOffsetY * k
  }

  const stroke = style.strokeColor !== null && style.strokeWidth > 0
  if (stroke) {
    ctx.lineWidth = style.strokeWidth * 2
    ctx.strokeStyle = style.strokeColor ?? '#000000'
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
  }
  ctx.fillStyle = style.color
  const baseline = style.underline ? middleToBaseline(ctx, size) : 0

  for (const line of layout.lines) {
    if (line.text === '') continue
    if (stroke) ctx.strokeText(line.text, line.x, line.y)
    ctx.fillText(line.text, line.x, line.y)
    if (style.underline) {
      const u = underlineRect(line, size, baseline)
      if (u) {
        if (stroke) ctx.strokeRect(u.x, u.y, u.w, u.h)
        ctx.fillRect(u.x, u.y, u.w, u.h)
      }
    }
  }

  ctx.restore()
  return {
    x: cx - (layout.width * scaleX) / 2,
    y: cy - (layout.height * scaleY) / 2,
    w: layout.width * scaleX,
    h: layout.height * scaleY,
  }
}

/**
 * Make sure the web fonts used by the given text sources are loaded (family,
 * weight and italic), so the first rendered frames don't fall back to a
 * system font. Failures are ignored (the fallback font is used).
 */
export async function loadTextFonts(sources: readonly MediaSource[]): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  const loads: Promise<unknown>[] = []
  // Elements pack templates all use one family (several weights).
  if (sources.some((s) => s.kind === 'element')) {
    for (const weight of [500, 600, 700, 800]) {
      loads.push(
        document.fonts
          .load(`${String(weight)} 48px ${ELEMENT_FONT_FAMILY}`, 'Subscribe 0123456789')
          .catch(() => {}),
      )
    }
  }
  const seen = new Set<string>()
  for (const s of sources) {
    if (s.kind !== 'text' || !s.text) continue
    const style = resolveTextStyle(s.text)
    const font = fontShorthand(style, 48)
    // One load per face (the sample text decides which unicode subsets load).
    const key = `${font}|${style.content}`
    if (seen.has(key)) continue
    seen.add(key)
    loads.push(document.fonts.load(font, style.content || ' ').catch(() => {}))
  }
  await Promise.all(loads)
}
