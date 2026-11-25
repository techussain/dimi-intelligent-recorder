/**
 * Vector shapes (rectangle, ellipse, line, arrow): defaults, limits and the
 * one drawing routine shared by the compositor (`drawScene`), posters and
 * the Media Library buttons. Pure apart from the canvas context it is given.
 *
 * A shape is drawn into a box w × h centred on the context origin (the
 * layer box after placement), so it stays sharp at any export size. Sizes in
 * `ShapeInfo` are intrinsic px; stroke width and corner radius scale with
 * the box like the rest of the shape.
 */
import type { ShapeInfo, ShapeType } from '../timeline/types'

/** DataTransfer type used when dragging a shape button onto the timeline. */
export const SHAPE_DRAG_MIME = 'application/x-dimi-shape'

export const SHAPE_TYPES: readonly ShapeType[] = ['rect', 'ellipse', 'line', 'arrow']

export const SHAPE_LABELS: Record<ShapeType, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
}

/** Default clip length (s) of a new shape. */
export const SHAPE_DEFAULT_DURATION = 5
export const MAX_SHAPE_STROKE = 200
export const MAX_SHAPE_SIZE = 8000

const DEFAULTS: Record<ShapeType, ShapeInfo> = {
  rect: {
    type: 'rect',
    fill: '#7c3aed',
    stroke: '#ffffff',
    strokeWidth: 0,
    radius: 24,
    width: 480,
    height: 270,
  },
  ellipse: {
    type: 'ellipse',
    fill: '#22c55e',
    stroke: '#ffffff',
    strokeWidth: 0,
    radius: 0,
    width: 320,
    height: 320,
  },
  line: {
    type: 'line',
    fill: 'transparent',
    stroke: '#ffffff',
    strokeWidth: 8,
    radius: 0,
    width: 600,
    height: 24,
  },
  arrow: {
    type: 'arrow',
    fill: 'transparent',
    stroke: '#facc15',
    strokeWidth: 10,
    radius: 0,
    width: 600,
    height: 80,
  },
}

export function isShapeType(v: unknown): v is ShapeType {
  return typeof v === 'string' && (SHAPE_TYPES as readonly string[]).includes(v)
}

/** A fresh default shape of `type`. */
export function defaultShape(type: ShapeType): ShapeInfo {
  return { ...DEFAULTS[type] }
}

function clamp(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
}

/** Clamp a shape's numbers to their limits (the colours pass through). */
export function normalizeShape(s: ShapeInfo): ShapeInfo {
  const width = clamp(s.width, 1, MAX_SHAPE_SIZE, 100)
  const height = clamp(s.height, 1, MAX_SHAPE_SIZE, 100)
  return {
    type: isShapeType(s.type) ? s.type : 'rect',
    fill: s.fill,
    stroke: s.stroke,
    strokeWidth: clamp(s.strokeWidth, 0, MAX_SHAPE_STROKE, 0),
    radius: clamp(s.radius, 0, Math.min(width, height) / 2, 0),
    width,
    height,
  }
}

/** Line and arrow shapes are drawn with the stroke only. */
export function isStrokeShape(type: ShapeType): boolean {
  return type === 'line' || type === 'arrow'
}

/** True for a colour that paints nothing ('transparent' / empty). */
export function isNoColor(c: string | undefined): boolean {
  if (!c) return true
  const v = c.trim().toLowerCase()
  return v === '' || v === 'transparent' || v === 'none'
}

export interface ShapeBox {
  w: number
  h: number
}

/** Arrow head length and half-width for a stroke width (box px). */
export function arrowHead(
  lineWidth: number,
  w: number,
  h: number,
): {
  length: number
  half: number
} {
  const half = Math.min(Math.max(lineWidth * 2, lineWidth / 2 + 4), h / 2)
  const length = Math.min(Math.max(lineWidth * 3.5, 10), w * 0.5)
  return { length, half }
}

/**
 * Draw `shape` into a `box` (positive w × h, project px) centred on the
 * current origin. Outlines are inset so everything stays inside the box
 * (the selection box matches what is drawn).
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: ShapeInfo,
  box: ShapeBox,
): void {
  const w = Math.abs(box.w)
  const h = Math.abs(box.h)
  if (!(w > 0) || !(h > 0)) return
  const kx = w / Math.max(1e-6, shape.width)
  const ky = h / Math.max(1e-6, shape.height)
  // Strokes scale with the box (geometric mean for non-uniform scaling).
  const k = Math.sqrt(kx * ky)
  const strokeOnly = isStrokeShape(shape.type)
  let lw = Math.max(0, shape.strokeWidth) * k
  if (strokeOnly) lw = Math.min(Math.max(lw, 0.5), h)
  else lw = Math.min(lw, Math.min(w, h) / 2)
  const hasStroke = lw > 0 && !isNoColor(shape.stroke)
  const hasFill = !strokeOnly && !isNoColor(shape.fill)

  ctx.save()
  ctx.lineJoin = 'round'
  if (shape.type === 'rect' || shape.type === 'ellipse') {
    // The outline is centred on the path: inset it by half its width.
    const inset = hasStroke ? lw / 2 : 0
    const rw = Math.max(0, w - inset * 2)
    const rh = Math.max(0, h - inset * 2)
    ctx.beginPath()
    if (shape.type === 'ellipse') {
      ctx.ellipse(0, 0, rw / 2, rh / 2, 0, 0, Math.PI * 2)
    } else {
      const r = Math.max(
        0,
        Math.min(shape.radius * Math.min(kx, ky) - inset, rw / 2, rh / 2),
      )
      roundedRectPath(ctx, -rw / 2, -rh / 2, rw, rh, r)
    }
    if (hasFill) {
      ctx.fillStyle = shape.fill
      ctx.fill()
    }
    if (hasStroke) {
      ctx.strokeStyle = shape.stroke
      ctx.lineWidth = lw
      ctx.stroke()
    }
  } else if (!isNoColor(shape.stroke)) {
    ctx.strokeStyle = shape.stroke
    ctx.fillStyle = shape.stroke
    ctx.lineWidth = lw
    const left = -w / 2
    const right = w / 2
    if (shape.type === 'line') {
      // Round caps reach lw/2 past the ends: keep them in the box.
      const cap = Math.min(lw / 2, w / 2)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(left + cap, 0)
      ctx.lineTo(right - cap, 0)
      ctx.stroke()
    } else {
      const head = arrowHead(lw, w, h)
      const tip = right
      const base = tip - head.length
      ctx.lineCap = 'butt'
      // Shaft up to just inside the head (no gap at the joint).
      ctx.beginPath()
      ctx.moveTo(left, 0)
      ctx.lineTo(Math.max(left, base + Math.min(lw, head.length) * 0.5), 0)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(tip, 0)
      ctx.lineTo(base, -head.half)
      ctx.lineTo(base, head.half)
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.restore()
}

/** Rounded rectangle path (no `roundRect` dependency, radius pre-clamped). */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (r <= 0) {
    ctx.rect(x, y, w, h)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}
