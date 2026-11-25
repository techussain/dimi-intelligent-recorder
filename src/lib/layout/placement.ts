/**
 * Object placement: the ONE definition of where a clip's picture lands on
 * the frame, shared by the compositor (`drawScene` media / element / text
 * branches, `layerPointOnFrame`), the layout geometry (selection boxes,
 * handles, hit-testing, snapping, align) and the transform tools.
 *
 * Semantics (project px, degrees clockwise):
 *  - Base box B = (cx, cy, w, h): where the object sits untransformed
 *    (contain-fit / PIP corner / element template / measured text).
 *  - Crop (pictures only) shrinks B to the kept region, at that region's own
 *    place inside B: w' = w·(1 − l − r), cx' = cx + w·(l − r)/2 (same for y).
 *    The picture is not rescaled, so the kept content does not move.
 *  - Anchor (ax, ay) ∈ [0, 1]² is a point of the (cropped) box in content
 *    coordinates. Its frame position is the pivot
 *      P = (cx' + x + (ax − ½)·w', cy' + y + (ay − ½)·h'),
 *    independent of scale and rotation: (x, y) moves the anchor.
 *  - A content point q (offset from the box centre, unscaled) lands at
 *      P + R(rotation) · S · (q − a),  a = ((ax − ½)·w', (ay − ½)·h'),
 *    S = diag(scaleX, scaleY); a negative scale mirrors about the anchor.
 *
 * With the default anchor (½, ½) and no crop this is exactly the original
 * T·R·S about the box centre, so old projects render unchanged.
 *
 * Pure: no React, no DOM, no compositor imports.
 */
import type { ClipCrop, MediaSource, Transform } from '../timeline/types'

export interface PointLike {
  x: number
  y: number
}

/** Untransformed object box (centre + size, project px). */
export interface BaseRect {
  cx: number
  cy: number
  w: number
  h: number
}

/** A rectangle of source pixels (9-argument drawImage). */
export interface SourceRegion {
  sx: number
  sy: number
  sw: number
  sh: number
}

/** The transform fields placement reads. */
export type PlacementTransform = Pick<
  Transform,
  'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'anchorX' | 'anchorY'
>

/** Largest crop per edge, and per axis (left + right, top + bottom). */
export const MAX_CROP = 0.95
export const DEFAULT_ANCHOR = 0.5

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Anchor fractions, defaulted (0.5) and clamped to 0..1. */
export function anchorOf(tf: Pick<Transform, 'anchorX' | 'anchorY'>): {
  ax: number
  ay: number
} {
  const f = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? DEFAULT_ANCHOR : clamp(v, 0, 1)
  return { ax: f(tf.anchorX), ay: f(tf.anchorY) }
}

/** True when the anchor is (effectively) the box centre. */
export function isDefaultAnchor(tf: Pick<Transform, 'anchorX' | 'anchorY'>): boolean {
  const { ax, ay } = anchorOf(tf)
  return Math.abs(ax - 0.5) < 1e-9 && Math.abs(ay - 0.5) < 1e-9
}

// ── Crop ────────────────────────────────────────────────────────────────────

/** Source kinds that can be cropped (pictures, not text / vector elements). */
export function isCroppableKind(kind: MediaSource['kind']): boolean {
  return kind === 'video' || kind === 'image' || kind === 'animation'
}

/**
 * Clamp a crop to the allowed range (each edge 0..0.95, each axis sum
 * <= 0.95, scaled down proportionally when over). An empty crop → undefined.
 */
export function normalizeCrop(
  c: Partial<ClipCrop> | null | undefined,
): ClipCrop | undefined {
  if (!c) return undefined
  const f = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? 0 : clamp(v, 0, MAX_CROP)
  let left = f(c.left)
  let right = f(c.right)
  let top = f(c.top)
  let bottom = f(c.bottom)
  if (left + right > MAX_CROP) {
    const k = MAX_CROP / (left + right)
    left *= k
    right *= k
  }
  if (top + bottom > MAX_CROP) {
    const k = MAX_CROP / (top + bottom)
    top *= k
    bottom *= k
  }
  if (left < 1e-6 && right < 1e-6 && top < 1e-6 && bottom < 1e-6) return undefined
  return { left, top, right, bottom }
}

/** The crop that applies to a clip of `kind` (none for text / elements). */
export function effectiveCrop(
  kind: MediaSource['kind'],
  crop: ClipCrop | null | undefined,
): ClipCrop | undefined {
  return isCroppableKind(kind) ? normalizeCrop(crop) : undefined
}

/** The base box after the crop: the kept region, where it was inside `base`. */
export function cropBaseBox(base: BaseRect, crop?: ClipCrop | null): BaseRect {
  if (!crop) return base
  return {
    cx: base.cx + (base.w * (crop.left - crop.right)) / 2,
    cy: base.cy + (base.h * (crop.top - crop.bottom)) / 2,
    w: base.w * (1 - crop.left - crop.right),
    h: base.h * (1 - crop.top - crop.bottom),
  }
}

/** The kept region in source pixels of a `srcW`×`srcH` picture. */
export function cropSourceRect(
  crop: ClipCrop | null | undefined,
  srcW: number,
  srcH: number,
): SourceRegion {
  if (!crop) return { sx: 0, sy: 0, sw: srcW, sh: srcH }
  return {
    sx: crop.left * srcW,
    sy: crop.top * srcH,
    sw: srcW * (1 - crop.left - crop.right),
    sh: srcH * (1 - crop.top - crop.bottom),
  }
}

// ── Placement ───────────────────────────────────────────────────────────────

/** Where an object's box lands (see the module comment). */
export interface Placement {
  /** The anchor point on the frame (rotation / scale pivot). */
  pivotX: number
  pivotY: number
  rotation: number
  /** Scaled box size, signed: base.w × scaleX (negative = mirrored). */
  w: number
  h: number
  /** Box centre relative to the pivot, before rotation. */
  offsetX: number
  offsetY: number
  /** Box centre on the frame. */
  centerX: number
  centerY: number
}

/** Rotate the vector (x, y) by `deg` degrees (clockwise on screen). */
export function rotateVec(x: number, y: number, deg: number): PointLike {
  if (!deg) return { x, y }
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

export function placeObject(base: BaseRect, tf: PlacementTransform): Placement {
  const { ax, ay } = anchorOf(tf)
  const pivotX = base.cx + tf.x + (ax - 0.5) * base.w
  const pivotY = base.cy + tf.y + (ay - 0.5) * base.h
  const w = base.w * tf.scaleX
  const h = base.h * tf.scaleY
  const offsetX = -(ax - 0.5) * w
  const offsetY = -(ay - 0.5) * h
  const c = rotateVec(offsetX, offsetY, tf.rotation)
  return {
    pivotX,
    pivotY,
    rotation: tf.rotation,
    w,
    h,
    offsetX,
    offsetY,
    centerX: pivotX + c.x,
    centerY: pivotY + c.y,
  }
}

/**
 * Frame position of the box's content point (u, v) — 0..1 in the object's
 * own (unmirrored) coordinates, so it follows a flip.
 */
export function placementPoint(p: Placement, u: number, v: number): PointLike {
  const r = rotateVec((u - 0.5) * p.w, (v - 0.5) * p.h, p.rotation)
  return { x: p.centerX + r.x, y: p.centerY + r.y }
}

/**
 * Move a canvas origin to the box centre with the box's rotation (not its
 * scale): translate(pivot) · rotate · translate(offset). Callers then draw
 * the box centred on the origin, `|w|`×`|h|` (mirroring with ctx.scale).
 */
export function applyPlacement(
  ctx: Pick<CanvasRenderingContext2D, 'translate' | 'rotate'>,
  p: Placement,
): void {
  ctx.translate(p.pivotX, p.pivotY)
  if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180)
  if (p.offsetX || p.offsetY) ctx.translate(p.offsetX, p.offsetY)
}

/** The (x, y) that put the box centre at `center` with `tf`'s other fields. */
export function translationForCenter(
  base: BaseRect,
  tf: Omit<PlacementTransform, 'x' | 'y'>,
  center: PointLike,
): { x: number; y: number } {
  const { ax, ay } = anchorOf(tf)
  const off = rotateVec(
    -(ax - 0.5) * base.w * tf.scaleX,
    -(ay - 0.5) * base.h * tf.scaleY,
    tf.rotation,
  )
  const pivotX = center.x - off.x
  const pivotY = center.y - off.y
  return {
    x: pivotX - base.cx - (ax - 0.5) * base.w,
    y: pivotY - base.cy - (ay - 0.5) * base.h,
  }
}

/**
 * Move the anchor to (ax, ay) without moving the object on screen: the box
 * centre, scale and rotation stay, (x, y) is recomputed.
 */
export function anchorChangePatch(
  base: BaseRect,
  tf: PlacementTransform,
  ax: number,
  ay: number,
): { x: number; y: number; anchorX: number; anchorY: number } {
  const anchorX = clamp(Number.isFinite(ax) ? ax : 0.5, 0, 1)
  const anchorY = clamp(Number.isFinite(ay) ? ay : 0.5, 0, 1)
  const p = placeObject(base, tf)
  const t = translationForCenter(
    base,
    { ...tf, anchorX, anchorY },
    { x: p.centerX, y: p.centerY },
  )
  return { x: t.x, y: t.y, anchorX, anchorY }
}

/**
 * The (x, y) that keep the remaining content in place on screen when the
 * crop of an object with uncropped base `fullBase` changes.
 */
export function cropChangePatch(
  fullBase: BaseRect,
  tf: PlacementTransform,
  from: ClipCrop | null | undefined,
  to: ClipCrop | null | undefined,
): { x: number; y: number } {
  const a = cropBaseBox(fullBase, from)
  const b = cropBaseBox(fullBase, to)
  const p = placeObject(a, tf)
  const d = rotateVec((b.cx - a.cx) * tf.scaleX, (b.cy - a.cy) * tf.scaleY, tf.rotation)
  return translationForCenter(b, tf, { x: p.centerX + d.x, y: p.centerY + d.y })
}

/** Where the whole (uncropped) picture lies: centre + signed size. */
export function uncroppedPlacement(
  fullBase: BaseRect,
  crop: ClipCrop | null | undefined,
  tf: PlacementTransform,
): { centerX: number; centerY: number; w: number; h: number; rotation: number } {
  const b = cropBaseBox(fullBase, crop)
  const p = placeObject(b, tf)
  const d = rotateVec(
    (fullBase.cx - b.cx) * tf.scaleX,
    (fullBase.cy - b.cy) * tf.scaleY,
    tf.rotation,
  )
  return {
    centerX: p.centerX + d.x,
    centerY: p.centerY + d.y,
    w: fullBase.w * tf.scaleX,
    h: fullBase.h * tf.scaleY,
    rotation: tf.rotation,
  }
}
