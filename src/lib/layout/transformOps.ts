/**
 * Pure transform-tool maths: flip, fit / fill, reset, the 9-point position
 * presets, and width / height edits with the aspect lock. Each returns a
 * patch for the store's `setTransforms`; callers apply them (layout/actions).
 */
import type { Transform } from '../timeline/types'
import { axisAlignedBounds, boxBase, type Bounds, type VisualBox } from './geometry'
import { translationForCenter } from './placement'

export interface Frame {
  w: number
  h: number
}

const sign = (v: number) => (v < 0 ? -1 : 1)

/** The placement fields of `box` with other (signed) scales. */
function placementOf(box: VisualBox, scaleX: number, scaleY: number) {
  return {
    scaleX,
    scaleY,
    rotation: box.rotation,
    anchorX: box.anchorX,
    anchorY: box.anchorY,
  }
}

// ── Flip ────────────────────────────────────────────────────────────────────

export type FlipAxis = 'h' | 'v'

/**
 * Mirror an object in place: negate scaleX ('h') or scaleY ('v') and keep
 * the box centre where it is (with an off-centre anchor the pivot would
 * otherwise swing the box across it). `transform` is what `box` was placed
 * with.
 */
export function flipPatch(
  box: VisualBox,
  transform: Transform,
  axis: FlipAxis,
): Pick<Transform, 'x' | 'y' | 'scaleX' | 'scaleY'> {
  const scaleX = axis === 'h' ? -transform.scaleX : transform.scaleX
  const scaleY = axis === 'v' ? -transform.scaleY : transform.scaleY
  const t = translationForCenter(boxBase(box), placementOf(box, scaleX, scaleY), {
    x: box.centerX,
    y: box.centerY,
  })
  return { x: t.x, y: t.y, scaleX, scaleY }
}

// ── Fit / fill ──────────────────────────────────────────────────────────────

export type FitMode = 'fit' | 'fill'

/**
 * Uniform scale (keeping flips and rotation) so the object fits inside the
 * frame ('fit', contain: its rotated bounds touch the frame) or covers it
 * ('fill': no frame corner left uncovered), centred on the frame.
 */
export function fitPatch(
  box: VisualBox,
  frame: Frame,
  mode: FitMode,
): Pick<Transform, 'x' | 'y' | 'scaleX' | 'scaleY'> {
  const bw = Math.max(1e-6, box.baseWidth)
  const bh = Math.max(1e-6, box.baseHeight)
  const r = (box.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(r))
  const sin = Math.abs(Math.sin(r))
  let s: number
  if (mode === 'fit') {
    // Rotated bounds at scale 1, scaled to fit inside the frame.
    const aabbW = bw * cos + bh * sin
    const aabbH = bw * sin + bh * cos
    s = Math.min(frame.w / aabbW, frame.h / aabbH)
  } else {
    // The frame's corners must lie inside the rotated box.
    s = Math.max(
      (frame.w * cos + frame.h * sin) / bw,
      (frame.w * sin + frame.h * cos) / bh,
    )
  }
  const scaleX = (box.flipX ? -1 : 1) * s
  const scaleY = (box.flipY ? -1 : 1) * s
  const t = translationForCenter(boxBase(box), placementOf(box, scaleX, scaleY), {
    x: frame.w / 2,
    y: frame.h / 2,
  })
  return { x: t.x, y: t.y, scaleX, scaleY }
}

// ── Reset ───────────────────────────────────────────────────────────────────

/**
 * Identity position / scale / rotation and the default (centre) anchor.
 * Opacity and the aspect lock are kept; the caller also clears the crop.
 */
export function resetPatch(): Partial<Transform> {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    anchorX: undefined,
    anchorY: undefined,
  }
}

// ── Position presets ────────────────────────────────────────────────────────

export type PositionPreset =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right'

/** Row-major 3×3 grid (for the preset picker). */
export const POSITION_PRESETS: readonly PositionPreset[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
]

/** Default margin: 5 % of the frame (inside the 90 % action-safe area). */
export const PRESET_MARGIN = 0.05

/**
 * Move that puts axis-aligned `bounds` at `preset` on the frame: corners /
 * edges sit `margin` (fraction of the frame size) from the frame edges,
 * centres on the frame centre lines.
 */
export function presetDelta(
  bounds: Bounds,
  preset: PositionPreset,
  frame: Frame,
  margin = PRESET_MARGIN,
): { dx: number; dy: number } {
  const mx = frame.w * margin
  const my = frame.h * margin
  const horiz = preset.endsWith('left') ? -1 : preset.endsWith('right') ? 1 : 0
  const vert = preset.startsWith('top') ? -1 : preset.startsWith('bottom') ? 1 : 0
  const dx =
    horiz < 0
      ? mx - bounds.left
      : horiz > 0
        ? frame.w - mx - bounds.right
        : frame.w / 2 - (bounds.left + bounds.right) / 2
  const dy =
    vert < 0
      ? my - bounds.top
      : vert > 0
        ? frame.h - my - bounds.bottom
        : frame.h / 2 - (bounds.top + bounds.bottom) / 2
  return { dx, dy }
}

/** `presetDelta` for a (possibly rotated) box. */
export function presetDeltaForBox(
  box: VisualBox,
  preset: PositionPreset,
  frame: Frame,
  margin = PRESET_MARGIN,
): { dx: number; dy: number } {
  return presetDelta(axisAlignedBounds(box), preset, frame, margin)
}

// ── Size + aspect lock ──────────────────────────────────────────────────────

/** Whether width / height edits keep the aspect ratio (default: yes). */
export function isAspectLocked(tf: Pick<Transform, 'lockAspect'>): boolean {
  return tf.lockAspect !== false
}

/** Smallest width / height the size fields accept (project px). */
export const MIN_SIZE_PX = 1

/**
 * Scales for a new width or height (project px) of an object whose base
 * box is `baseW`×`baseH`. Signs (flips) are kept; with the aspect lock the
 * other side follows proportionally.
 */
export function sizePatch(
  baseW: number,
  baseH: number,
  tf: Pick<Transform, 'scaleX' | 'scaleY' | 'lockAspect'>,
  next: { width?: number; height?: number },
): Pick<Transform, 'scaleX' | 'scaleY'> {
  const bw = Math.max(1e-6, baseW)
  const bh = Math.max(1e-6, baseH)
  let ax = Math.abs(tf.scaleX)
  let ay = Math.abs(tf.scaleY)
  const lock = isAspectLocked(tf)
  if (next.width !== undefined && Number.isFinite(next.width)) {
    const nx = Math.max(MIN_SIZE_PX, next.width) / bw
    if (lock && ax > 1e-9) ay *= nx / ax
    ax = nx
  } else if (next.height !== undefined && Number.isFinite(next.height)) {
    const ny = Math.max(MIN_SIZE_PX, next.height) / bh
    if (lock && ay > 1e-9) ax *= ny / ay
    ay = ny
  }
  return { scaleX: sign(tf.scaleX) * ax, scaleY: sign(tf.scaleY) * ay }
}

/**
 * A Scale X / Scale Y field edit: with the aspect lock the other scale
 * follows proportionally (keeping its own sign).
 */
export function scaleFieldPatch(
  tf: Pick<Transform, 'scaleX' | 'scaleY' | 'lockAspect'>,
  axis: 'scaleX' | 'scaleY',
  value: number,
): Partial<Pick<Transform, 'scaleX' | 'scaleY'>> {
  if (!Number.isFinite(value)) return {}
  const other = axis === 'scaleX' ? 'scaleY' : 'scaleX'
  const prev = tf[axis]
  if (!isAspectLocked(tf) || Math.abs(prev) < 1e-9) return { [axis]: value }
  const ratio = Math.abs(value) / Math.abs(prev)
  return { [axis]: value, [other]: tf[other] * ratio }
}
