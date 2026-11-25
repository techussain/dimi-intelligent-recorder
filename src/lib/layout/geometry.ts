/**
 * Object geometry in PROJECT pixels: where each visual clip sits on the
 * frame (its selection box), hit-testing, axis-aligned bounds and the
 * resize-handle maths. Shared by the preview handles, alignment, snapping
 * and nudging, and kept in step with `drawScene` (compositor/scene.ts) so
 * a box always matches what is drawn.
 *
 * Pure: no React and no DOM. Text boxes need a text measurer, which callers
 * inject (see layout/textMeasure.ts for the canvas one; tests pass a mock).
 *
 * Placement (crop, anchor, scale, rotation, flip) is defined once in
 * layout/placement.ts; `placeBox` turns it into a selection box.
 */
import {
  baseBox,
  findActiveClip,
  vectorBaseBox,
  sampleTransform,
} from '../compositor/scene'
import type { TextBoxRect, TextRenderTransform } from '../compositor/textRender'
import { isTrackHidden } from '../timeline/trackState'
import type {
  Clip,
  ClipCrop,
  MediaSource,
  Project,
  TextStyle,
  Track,
  Transform,
} from '../timeline/types'
import {
  MAX_CROP,
  anchorOf,
  cropBaseBox,
  cropChangePatch,
  effectiveCrop,
  normalizeCrop,
  placeObject,
  translationForCenter,
  uncroppedPlacement,
  type BaseRect,
} from './placement'

export interface Point {
  x: number
  y: number
}

/** Axis-aligned bounds (project px). */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** A (possibly rotated) object box. `width` / `height` are always >= 0. */
export interface VisualBox {
  /** Left/top of the box before it is rotated about its centre. */
  left: number
  top: number
  width: number
  height: number
  centerX: number
  centerY: number
  /** Degrees, clockwise (canvas convention). */
  rotation: number
  /**
   * Untransformed (scale 1) size and centre, before the clip transform and
   * after the crop (the kept region).
   */
  baseWidth: number
  baseHeight: number
  baseCenterX: number
  baseCenterY: number
  /** Mirrored horizontally / vertically (negative scale). */
  flipX: boolean
  flipY: boolean
  /** Anchor fractions (0..1, content coordinates) and its frame position. */
  anchorX: number
  anchorY: number
  pivotX: number
  pivotY: number
  /** Base box before the crop, and the crop (null = none / not croppable). */
  fullBase: BaseRect
  crop: ClipCrop | null
}

/**
 * Measures a text source the way the compositor draws it: the rect returned
 * by `drawTextSource(ctx, text, frameW, frameH, transform)`. Null = unavailable.
 */
export type TextMeasurer = (
  text: TextStyle,
  frameW: number,
  frameH: number,
  transform?: TextRenderTransform,
) => TextBoxRect | null

export interface VisualOverlay {
  clip: Clip
  source: MediaSource
  track: Track
  /** Transform at the playhead (keyframes applied). */
  transform: Transform
  box: VisualBox
}

/** A visual clip under the playhead, before measuring its box. */
export interface ActiveVisualClip {
  clip: Clip
  source: MediaSource
  track: Track
}

// ── Boxes ───────────────────────────────────────────────────────────────────

/** Selection box of an object with uncropped base `fullBase`. */
export function placeBox(
  fullBase: BaseRect,
  transform: Transform,
  crop?: ClipCrop | null,
): VisualBox {
  const kept = normalizeCrop(crop) ?? null
  const base = cropBaseBox(fullBase, kept)
  const p = placeObject(base, transform)
  const anchor = anchorOf(transform)
  const width = Math.abs(p.w)
  const height = Math.abs(p.h)
  return {
    left: p.centerX - width / 2,
    top: p.centerY - height / 2,
    width,
    height,
    centerX: p.centerX,
    centerY: p.centerY,
    rotation: transform.rotation,
    baseWidth: Math.abs(base.w),
    baseHeight: Math.abs(base.h),
    baseCenterX: base.cx,
    baseCenterY: base.cy,
    flipX: transform.scaleX < 0,
    flipY: transform.scaleY < 0,
    anchorX: anchor.ax,
    anchorY: anchor.ay,
    pivotX: p.pivotX,
    pivotY: p.pivotY,
    fullBase: { ...fullBase },
    crop: kept,
  }
}

/** The cropped base box of `box` (what the transform scales). */
export function boxBase(box: VisualBox): BaseRect {
  return {
    cx: box.baseCenterX,
    cy: box.baseCenterY,
    w: box.baseWidth,
    h: box.baseHeight,
  }
}

/** The placement fields of `box` with other (signed) scales. */
function boxTransform(box: VisualBox, scaleX: number, scaleY: number) {
  return {
    scaleX,
    scaleY,
    rotation: box.rotation,
    anchorX: box.anchorX,
    anchorY: box.anchorY,
  }
}

/** Box of a text source, laid out like `drawTextSource` draws it. */
export function measureTextBox(
  project: Pick<Project, 'width' | 'height'>,
  text: TextStyle,
  transform: Transform,
  measureText: TextMeasurer,
): VisualBox | null {
  const baseRect = measureText(text, project.width, project.height)
  if (!baseRect) return null
  // drawTextSource uses the scale-1 rect centred on the frame as the base
  // box, then places it like any object (anchor, scale, rotation).
  return placeBox(
    { cx: project.width / 2, cy: project.height / 2, w: baseRect.w, h: baseRect.h },
    transform,
  )
}

/**
 * The selection box of a visual clip with `transform`: the same placement
 * as `drawScene` (contain-fit on main tracks, the PIP corner on overlay
 * tracks, the template / shape box for elements and shapes, the measured
 * box for text), with
 * the clip's `crop` (pictures only) and anchor applied.
 * A 'grow' zoom is an effect, not a transform: the box follows the base.
 */
export function visualBox(
  project: Pick<Project, 'width' | 'height'>,
  track: Pick<Track, 'kind'>,
  source: MediaSource,
  transform: Transform,
  measureText?: TextMeasurer,
  crop?: ClipCrop | null,
): VisualBox | null {
  if (source.kind === 'text') {
    if (!source.text || !measureText) return null
    return measureTextBox(project, source.text, transform, measureText)
  }
  if (source.kind === 'audio') return null
  const srcW = source.width ?? project.width
  const srcH = source.height ?? project.height
  if (!srcW || !srcH) return null
  const base =
    vectorBaseBox(project.width, project.height, source) ??
    baseBox(
      project.width,
      project.height,
      track.kind === 'overlay' && !source.fullFrame,
      srcW,
      srcH,
    )
  return placeBox(base, transform, effectiveCrop(source.kind, crop))
}

/**
 * Visual clips under the playhead, topmost track first (track[0] is drawn on
 * top). Hidden tracks, live (recording) clips and audio are skipped.
 */
export function activeVisualClips(
  project: Project,
  playhead: number,
): ActiveVisualClip[] {
  const out: ActiveVisualClip[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'video' && track.kind !== 'overlay') continue
    if (isTrackHidden(project, track)) continue
    const clip = findActiveClip(project.clips, track.id, playhead)
    if (!clip || clip.isLive) continue
    const source = project.sources.find((s) => s.id === clip.sourceId)
    if (!source || source.kind === 'audio') continue
    out.push({ clip, source, track })
  }
  return out
}

/** Visual clips under the playhead with their boxes (topmost first). */
export function collectActiveVisuals(
  project: Project,
  playhead: number,
  measureText?: TextMeasurer,
): VisualOverlay[] {
  const overlays: VisualOverlay[] = []
  for (const { clip, source, track } of activeVisualClips(project, playhead)) {
    const transform = sampleTransform(clip, playhead)
    const box = visualBox(project, track, source, transform, measureText, clip.crop)
    if (!box) continue
    overlays.push({ clip, source, track, transform, box })
  }
  return overlays
}

// ── Bounds & hit-testing ────────────────────────────────────────────────────

/** Axis-aligned bounds of a (rotated) box. */
export function axisAlignedBounds(
  box: Pick<VisualBox, 'centerX' | 'centerY' | 'width' | 'height' | 'rotation'>,
): Bounds {
  const rad = (box.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const w = Math.abs(box.width)
  const h = Math.abs(box.height)
  const hw = (w * cos + h * sin) / 2
  const hh = (w * sin + h * cos) / 2
  return {
    left: box.centerX - hw,
    top: box.centerY - hh,
    right: box.centerX + hw,
    bottom: box.centerY + hh,
  }
}

/** Smallest bounds containing all of `list` (null when empty). */
export function unionBounds(list: readonly Bounds[]): Bounds | null {
  let out: Bounds | null = null
  for (const b of list) {
    if (!out) out = { ...b }
    else {
      out.left = Math.min(out.left, b.left)
      out.top = Math.min(out.top, b.top)
      out.right = Math.max(out.right, b.right)
      out.bottom = Math.max(out.bottom, b.bottom)
    }
  }
  return out
}

export function translateBounds(b: Bounds, dx: number, dy: number): Bounds {
  return {
    left: b.left + dx,
    top: b.top + dy,
    right: b.right + dx,
    bottom: b.bottom + dy,
  }
}

/**
 * Rotate `point` about the box centre by `degrees`, returning the offset from
 * the centre. With `-box.rotation` this maps a frame point into box space.
 */
export function rotateIntoLocal(
  point: Point,
  box: Pick<VisualBox, 'centerX' | 'centerY'>,
  degrees: number,
): Point {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = point.x - box.centerX
  const dy = point.y - box.centerY
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
  }
}

/** Box-space offset from the centre → frame point. */
export function localOffsetToWorld(
  box: Pick<VisualBox, 'centerX' | 'centerY' | 'rotation'>,
  local: Point,
): Point {
  const rad = (box.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: box.centerX + local.x * cos - local.y * sin,
    y: box.centerY + local.x * sin + local.y * cos,
  }
}

export function pointInBox(
  point: Point,
  box: Pick<VisualBox, 'centerX' | 'centerY' | 'width' | 'height' | 'rotation'>,
): boolean {
  const local = rotateIntoLocal(point, box, -box.rotation)
  return (
    Math.abs(local.x) <= Math.abs(box.width) / 2 &&
    Math.abs(local.y) <= Math.abs(box.height) / 2
  )
}

// ── Resize ──────────────────────────────────────────────────────────────────

export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export interface ResizeHandleSpec {
  id: ResizeHandle
  dirX: -1 | 0 | 1
  dirY: -1 | 0 | 1
  corner: boolean
}

export const MIN_BOX_SIZE = 24
export const MIN_SCALE = 0.05
export const MAX_SCALE = 8

/**
 * Transform patch for dragging resize `handle` of `startBox` to `point`.
 * The opposite edge/corner stays put (or the centre with `fromCenter`);
 * `proportional` keeps the box's current aspect ratio. A mirrored object
 * stays mirrored (the scale keeps its sign). The anchor keeps its place in
 * the object (same fractions); x / y are solved so the box lands exactly.
 */
export function computeResizePatch(
  startBox: VisualBox,
  point: Point,
  handle: Pick<ResizeHandleSpec, 'dirX' | 'dirY' | 'corner'>,
  proportional: boolean,
  fromCenter: boolean,
): Partial<Transform> {
  const local = rotateIntoLocal(point, startBox, -startBox.rotation)
  const startHalfW = startBox.width / 2
  const startHalfH = startBox.height / 2

  // Fixed point: the opposite corner/edge in local space (or the centre).
  const fixedX = fromCenter ? 0 : handle.dirX === 0 ? 0 : -handle.dirX * startHalfW
  const fixedY = fromCenter ? 0 : handle.dirY === 0 ? 0 : -handle.dirY * startHalfH

  let nextWidth = startBox.width
  let nextHeight = startBox.height

  if (handle.dirX !== 0) {
    const reach = Math.abs(local.x - fixedX)
    nextWidth = Math.max(MIN_BOX_SIZE, fromCenter ? reach * 2 : reach)
  }
  if (handle.dirY !== 0) {
    const reach = Math.abs(local.y - fixedY)
    nextHeight = Math.max(MIN_BOX_SIZE, fromCenter ? reach * 2 : reach)
  }

  // Proportional: preserve the box's current aspect ratio.
  if (proportional) {
    const startW = Math.max(1, startBox.width)
    const startH = Math.max(1, startBox.height)
    if (handle.corner) {
      const s = Math.max(nextWidth / startW, nextHeight / startH)
      nextWidth = startW * s
      nextHeight = startH * s
    } else if (handle.dirX !== 0) {
      nextHeight = startH * (nextWidth / startW)
    } else if (handle.dirY !== 0) {
      nextWidth = startW * (nextHeight / startH)
    }
  }

  // New centre in local space: midway between the fixed point and the dragged edge.
  let centerLocalX = 0
  let centerLocalY = 0
  if (!fromCenter) {
    const hx = handle.dirX === 0 ? 0 : fixedX + handle.dirX * nextWidth
    const hy = handle.dirY === 0 ? 0 : fixedY + handle.dirY * nextHeight
    centerLocalX = handle.dirX === 0 ? 0 : (fixedX + hx) / 2
    centerLocalY = handle.dirY === 0 ? 0 : (fixedY + hy) / 2
  }

  const center = localOffsetToWorld(startBox, { x: centerLocalX, y: centerLocalY })
  const signX = startBox.flipX ? -1 : 1
  const signY = startBox.flipY ? -1 : 1
  const scaleX =
    signX * clamp(nextWidth / Math.max(1, startBox.baseWidth), MIN_SCALE, MAX_SCALE)
  const scaleY =
    signY * clamp(nextHeight / Math.max(1, startBox.baseHeight), MIN_SCALE, MAX_SCALE)
  const t = translationForCenter(
    boxBase(startBox),
    boxTransform(startBox, scaleX, scaleY),
    center,
  )
  return { x: t.x, y: t.y, scaleX, scaleY }
}

/** The selection box after applying `patch` (and optionally a new crop). */
export function boxAfterPatch(
  box: VisualBox,
  transform: Transform,
  patch: Partial<Transform>,
  crop?: ClipCrop | null,
): VisualBox {
  return placeBox(
    box.fullBase,
    { ...transform, ...patch },
    crop === undefined ? box.crop : crop,
  )
}

// ── Crop ────────────────────────────────────────────────────────────────────

/**
 * Crop + position for dragging crop `handle` of `box` to `point`: the
 * dragged edge of the kept region follows the pointer (clamped to the
 * picture and the crop limits; at least MIN_BOX_SIZE px stay visible) and
 * x / y keep the remaining content where it is on screen. Handles are
 * visual: a mirrored object's left handle crops the content's right edge.
 */
export function computeCropPatch(
  box: VisualBox,
  transform: Transform,
  point: Point,
  handle: Pick<ResizeHandleSpec, 'dirX' | 'dirY'>,
): { crop: ClipCrop | undefined; x: number; y: number } {
  const start = box.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const full = uncroppedPlacement(box.fullBase, box.crop, transform)
  const fw = Math.max(1e-6, Math.abs(full.w))
  const fh = Math.max(1e-6, Math.abs(full.h))
  const local = rotateIntoLocal(
    point,
    { centerX: full.centerX, centerY: full.centerY },
    -transform.rotation,
  )
  // Visual fraction across the whole picture, then content fraction.
  const fx = local.x / fw + 0.5
  const fy = local.y / fh + 0.5
  const u = full.w < 0 ? 1 - fx : fx
  const v = full.h < 0 ? 1 - fy : fy
  const minX = Math.min(1, Math.max(1 - MAX_CROP, MIN_BOX_SIZE / fw))
  const minY = Math.min(1, Math.max(1 - MAX_CROP, MIN_BOX_SIZE / fh))
  const next = { ...start }
  if (handle.dirX !== 0) {
    const side = full.w < 0 ? -handle.dirX : handle.dirX
    if (side < 0) next.left = clamp(u, 0, Math.max(0, 1 - next.right - minX))
    else next.right = clamp(1 - u, 0, Math.max(0, 1 - next.left - minX))
  }
  if (handle.dirY !== 0) {
    const side = full.h < 0 ? -handle.dirY : handle.dirY
    if (side < 0) next.top = clamp(v, 0, Math.max(0, 1 - next.bottom - minY))
    else next.bottom = clamp(1 - v, 0, Math.max(0, 1 - next.top - minY))
  }
  const crop = normalizeCrop(next)
  const t = cropChangePatch(box.fullBase, transform, box.crop, crop)
  return { crop, x: t.x, y: t.y }
}

// ── Anchor ──────────────────────────────────────────────────────────────────

/**
 * Anchor fractions (content coordinates, clamped to the box) under the
 * frame point `point`. With `snap` > 0 (project px) they snap to the box
 * centre, edges and corners.
 */
export function anchorFromPoint(
  box: VisualBox,
  point: Point,
  snap = 0,
): { anchorX: number; anchorY: number } {
  const local = rotateIntoLocal(point, box, -box.rotation)
  const fx = clamp(local.x / Math.max(1e-6, box.width) + 0.5, 0, 1)
  const fy = clamp(local.y / Math.max(1e-6, box.height) + 0.5, 0, 1)
  const snapTo = (f: number, size: number) => {
    if (snap <= 0) return f
    for (const t of [0, 0.5, 1]) if (Math.abs(f - t) * size <= snap) return t
    return f
  }
  const vx = snapTo(fx, box.width)
  const vy = snapTo(fy, box.height)
  return {
    anchorX: box.flipX ? 1 - vx : vx,
    anchorY: box.flipY ? 1 - vy : vy,
  }
}

/**
 * Frame position of the edge(s) a resize handle drags on an unrotated box:
 * x for east/west handles, y for north/south (null where it doesn't drag).
 */
export function resizeEdgePosition(
  box: Pick<VisualBox, 'left' | 'top' | 'width' | 'height'>,
  handle: Pick<ResizeHandleSpec, 'dirX' | 'dirY'>,
): { x: number | null; y: number | null } {
  return {
    x: handle.dirX === 0 ? null : handle.dirX < 0 ? box.left : box.left + box.width,
    y: handle.dirY === 0 ? null : handle.dirY < 0 ? box.top : box.top + box.height,
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeDegrees(value: number): number {
  let next = value % 360
  if (next > 180) next -= 360
  if (next < -180) next += 360
  return next
}
