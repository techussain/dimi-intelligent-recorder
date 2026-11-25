/** Phase 2 transform maths: anchor, flip, crop placement and the transform tools. */
import { describe, it, expect } from 'vitest'
import {
  anchorFromPoint,
  axisAlignedBounds,
  boxAfterPatch,
  computeCropPatch,
  computeResizePatch,
  pointInBox,
  visualBox,
  type VisualBox,
} from '../geometry'
import {
  anchorChangePatch,
  cropBaseBox,
  cropChangePatch,
  cropSourceRect,
  normalizeCrop,
  placeObject,
  placementPoint,
  translationForCenter,
  type BaseRect,
} from '../placement'
import {
  fitPatch,
  flipPatch,
  presetDelta,
  resetPatch,
  scaleFieldPatch,
  sizePatch,
} from '../transformOps'
import { computeCrop } from '../../effects/sample'
import type { ClipCrop, MediaSource, Track, Transform } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

const project = { width: 1920, height: 1080 }
const video: Pick<Track, 'kind'> = { kind: 'video' }
const tf = (patch: Partial<Transform> = {}): Transform => ({
  ...identityTransform,
  ...patch,
})
const image = (w = 1920, h = 1080): MediaSource => ({
  id: 'img',
  kind: 'image',
  opfsPath: '',
  mimeType: '',
  duration: 5,
  width: w,
  height: h,
  createdAt: 0,
  name: 'img',
})
function box(t: Transform, crop?: ClipCrop): VisualBox {
  const b = visualBox(project, video, image(), t, undefined, crop)
  if (!b) throw new Error('no box')
  return b
}
const BASE: BaseRect = { cx: 960, cy: 540, w: 1920, h: 1080 }

describe('placement (anchor / flip)', () => {
  it('default anchor = the original T·R·S about the box centre', () => {
    const p = placeObject(BASE, tf({ x: 10, y: 20, scaleX: 0.5, rotation: 30 }))
    expect(p.centerX).toBeCloseTo(970)
    expect(p.centerY).toBeCloseTo(560)
    expect(p.pivotX).toBeCloseTo(970)
  })

  it('anchor at the top-left corner + 90° rotates about that corner', () => {
    const t = tf({ scaleX: 0.25, scaleY: 0.25, anchorX: 0, anchorY: 0, rotation: 90 })
    const p = placeObject(BASE, t)
    // Pivot = the unscaled box's top-left (0, 0) — independent of scale.
    expect(p.pivotX).toBeCloseTo(0)
    expect(p.pivotY).toBeCloseTo(0)
    // The scaled 480×270 box hangs below-left of the pivot after +90°.
    const tl = placementPoint(p, 0, 0)
    const tr = placementPoint(p, 1, 0)
    expect(tl.x).toBeCloseTo(0)
    expect(tl.y).toBeCloseTo(0)
    expect(tr.x).toBeCloseTo(0)
    expect(tr.y).toBeCloseTo(480)
    const b = box(t)
    expect(b.centerX).toBeCloseTo(-135)
    expect(b.centerY).toBeCloseTo(240)
    expect(b.pivotX).toBeCloseTo(0)
    expect(pointInBox({ x: -100, y: 300 }, b)).toBe(true)
    expect(pointInBox({ x: 100, y: 300 }, b)).toBe(false)
  })

  it('flip mirrors content about the anchor; the box stays positive', () => {
    const p = placeObject(BASE, tf({ scaleX: -0.5, scaleY: 0.5 }))
    // Content (0, *) — the picture's left edge — now lands on the right.
    expect(placementPoint(p, 0, 0.5).x).toBeCloseTo(960 + 480)
    expect(placementPoint(p, 1, 0.5).x).toBeCloseTo(960 - 480)
    const b = box(tf({ scaleX: -0.5, scaleY: 0.5 }))
    expect(b.width).toBeCloseTo(960)
    expect(b.flipX).toBe(true)
  })

  it('translationForCenter inverts placeObject', () => {
    const t = tf({
      scaleX: 0.3,
      scaleY: -0.7,
      rotation: 33,
      anchorX: 0.2,
      anchorY: 0.9,
    })
    const p = placeObject(BASE, t)
    const back = translationForCenter(BASE, t, { x: p.centerX, y: p.centerY })
    expect(back.x).toBeCloseTo(t.x)
    expect(back.y).toBeCloseTo(t.y)
  })
})

describe('anchor change keeps the object in place', () => {
  it('content points stay where they are on screen', () => {
    const t = tf({ x: 100, y: -50, scaleX: 0.4, scaleY: -0.6, rotation: 27 })
    const before = placeObject(BASE, t)
    const patch = anchorChangePatch(BASE, t, 0.1, 0.8)
    const after = placeObject(BASE, { ...t, ...patch })
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0.3, 0.7],
    ] as const) {
      const a = placementPoint(before, u, v)
      const b = placementPoint(after, u, v)
      expect(b.x).toBeCloseTo(a.x)
      expect(b.y).toBeCloseTo(a.y)
    }
    // The pivot is now at the content point (0.1, 0.8).
    const target = placementPoint(before, 0.1, 0.8)
    expect(after.pivotX).toBeCloseTo(target.x)
    expect(after.pivotY).toBeCloseTo(target.y)
  })

  it('anchorFromPoint reads content fractions (flip undone) and snaps', () => {
    const b = box(tf({ scaleX: -0.5, scaleY: 0.5 }))
    // Visual left quarter of a mirrored box = content x 0.75.
    const a = anchorFromPoint(b, { x: b.left + b.width * 0.25, y: b.centerY })
    expect(a.anchorX).toBeCloseTo(0.75)
    expect(a.anchorY).toBeCloseTo(0.5)
    const s = anchorFromPoint(b, { x: b.left + 3, y: b.top + 2 }, 6)
    expect(s.anchorX).toBe(1)
    expect(s.anchorY).toBe(0)
  })
})

describe('resize with an anchor', () => {
  it('east handle: the west edge stays, the anchor keeps its fractions', () => {
    const t = tf({ scaleX: 0.5, scaleY: 0.5, anchorX: 0, anchorY: 0 })
    const b = box(t)
    const patch = computeResizePatch(
      b,
      { x: b.left + 700, y: b.centerY },
      { dirX: 1, dirY: 0, corner: false },
      false,
      false,
    )
    const next = boxAfterPatch(b, t, patch)
    expect(next.left).toBeCloseTo(b.left)
    expect(next.width).toBeCloseTo(700)
    expect(next.top).toBeCloseTo(b.top)
    expect(next.anchorX).toBe(0)
  })

  it('rotated, anchored, mirrored: the opposite corner stays put', () => {
    const t = tf({
      scaleX: -0.4,
      scaleY: 0.4,
      rotation: 30,
      anchorX: 0.8,
      anchorY: 0.3,
    })
    const b = box(t)
    const corner = (bx: VisualBox, sx: number, sy: number) => {
      const r = (bx.rotation * Math.PI) / 180
      const lx = (sx * bx.width) / 2
      const ly = (sy * bx.height) / 2
      return {
        x: bx.centerX + lx * Math.cos(r) - ly * Math.sin(r),
        y: bx.centerY + lx * Math.sin(r) + ly * Math.cos(r),
      }
    }
    const fixed = corner(b, -1, -1)
    const drag = corner(b, 1.3, 1.1)
    const patch = computeResizePatch(
      b,
      drag,
      { dirX: 1, dirY: 1, corner: true },
      false,
      false,
    )
    const next = boxAfterPatch(b, t, patch)
    const nf = corner(next, -1, -1)
    expect(nf.x).toBeCloseTo(fixed.x)
    expect(nf.y).toBeCloseTo(fixed.y)
    expect(patch.scaleX).toBeLessThan(0)
  })

  it('proportional keeps the current aspect ratio', () => {
    const b = box(tf({ scaleX: 0.5, scaleY: 0.25 }))
    const patch = computeResizePatch(
      b,
      { x: b.left + b.width * 2, y: b.top + b.height * 1.2 },
      { dirX: 1, dirY: 1, corner: true },
      true,
      false,
    )
    expect((patch.scaleX ?? 0) / (patch.scaleY ?? 1)).toBeCloseTo(2)
  })
})

describe('crop', () => {
  it('normalizeCrop clamps edges and per-axis sums; empty → undefined', () => {
    expect(normalizeCrop({ left: 0, top: 0, right: 0, bottom: 0 })).toBeUndefined()
    const c = normalizeCrop({ left: 0.9, right: 0.9, top: -1, bottom: 2 })
    expect(c?.left).toBeCloseTo(0.475)
    expect(c?.right).toBeCloseTo(0.475)
    expect(c?.top).toBe(0)
    expect(c?.bottom).toBeCloseTo(0.95)
  })

  it('kept box: smaller, at its place inside the picture; source rect matches', () => {
    const crop = { left: 0.25, top: 0, right: 0, bottom: 0.1 }
    const b = cropBaseBox(BASE, crop)
    expect(b.w).toBeCloseTo(1440)
    expect(b.h).toBeCloseTo(972)
    expect(b.cx - b.w / 2).toBeCloseTo(480) // left edge where it was
    expect(b.cy - b.h / 2).toBeCloseTo(0)
    expect(cropSourceRect(crop, 1000, 500)).toEqual({
      sx: 250,
      sy: 0,
      sw: 750,
      sh: 450,
    })
    const vb = box(tf(), crop)
    expect(vb.width).toBeCloseTo(1440)
    expect(vb.left).toBeCloseTo(480)
    expect(vb.fullBase.w).toBe(1920)
  })

  it('crop change compensation keeps content still (scaled, rotated, anchored)', () => {
    const t = tf({
      scaleX: 0.6,
      scaleY: -0.5,
      rotation: 40,
      anchorX: 0.3,
      anchorY: 0.6,
    })
    const from = { left: 0.1, top: 0.05, right: 0, bottom: 0 }
    const to = { left: 0.3, top: 0.2, right: 0.15, bottom: 0.1 }
    const pa = placeObject(cropBaseBox(BASE, from), t)
    const patch = cropChangePatch(BASE, t, from, to)
    const pb = placeObject(cropBaseBox(BASE, to), { ...t, ...patch })
    // Source point (0.5, 0.5) → each box's own fractions.
    const uvIn = (c: ClipCrop) => ({
      u: (0.5 - c.left) / (1 - c.left - c.right),
      v: (0.5 - c.top) / (1 - c.top - c.bottom),
    })
    const a = placementPoint(pa, uvIn(from).u, uvIn(from).v)
    const b = placementPoint(pb, uvIn(to).u, uvIn(to).v)
    expect(b.x).toBeCloseTo(a.x)
    expect(b.y).toBeCloseTo(a.y)
  })

  it('crop handle: dragging the west edge 25 % in crops the left 25 %', () => {
    const t = tf()
    const b = box(t)
    const r = computeCropPatch(b, t, { x: 480, y: 540 }, { dirX: -1, dirY: 0 })
    expect(r.crop?.left).toBeCloseTo(0.25)
    expect(r.x).toBeCloseTo(0)
    const next = boxAfterPatch(b, t, { x: r.x, y: r.y }, r.crop ?? null)
    expect(next.left).toBeCloseTo(480)
    expect(next.width).toBeCloseTo(1440)
  })

  it('crop handle on a mirrored object crops the content edge under it', () => {
    const t = tf({ scaleX: -1 })
    const b = box(t)
    const r = computeCropPatch(b, t, { x: 480, y: 540 }, { dirX: -1, dirY: 0 })
    expect(r.crop?.right).toBeCloseTo(0.25)
    expect(r.crop?.left ?? 0).toBe(0)
    const next = boxAfterPatch(b, t, { x: r.x, y: r.y }, r.crop ?? null)
    expect(next.left).toBeCloseTo(480)
    expect(next.left + next.width).toBeCloseTo(1920)
  })

  it('crop handle clamps (95 % per axis, never past the other edge)', () => {
    const t = tf()
    const b = box(t, { left: 0.5, top: 0, right: 0, bottom: 0 })
    const r = computeCropPatch(b, t, { x: 900, y: 540 }, { dirX: 1, dirY: 0 })
    expect((r.crop?.left ?? 0) + (r.crop?.right ?? 0)).toBeLessThanOrEqual(0.95 + 1e-9)
  })

  it('zoom inside works within the kept region', () => {
    const region = cropSourceRect({ left: 0.5, top: 0, right: 0, bottom: 0 }, 1000, 500)
    const sample = { crop: { scale: 2, fx: 0.5, fy: 0.5 }, shake: null }
    const r = computeCrop(sample, 1000, 500, 960, 540, region)
    expect(r.sw).toBeCloseTo(250)
    expect(r.sh).toBeCloseTo(250)
    expect(r.sx).toBeCloseTo(625) // centred in [500, 1000]
    // Focus at the region edge: the viewport stays inside it.
    const edge = computeCrop(
      { ...sample, crop: { scale: 2, fx: 0, fy: 0 } },
      1000,
      500,
      1,
      1,
      region,
    )
    expect(edge.sx).toBeCloseTo(500)
    // No region: unchanged behaviour.
    expect(computeCrop(sample, 1000, 500, 960, 540).sx).toBeCloseTo(250)
  })
})

describe('transform tools', () => {
  const frame = { w: 1920, h: 1080 }

  it('flip keeps the box centre (off-centre anchor) and toggles the sign', () => {
    const t = tf({ x: 50, scaleX: 0.5, scaleY: 0.5, anchorX: 0, anchorY: 0 })
    const b = box(t)
    const patch = flipPatch(b, t, 'h')
    expect(patch.scaleX).toBeCloseTo(-0.5)
    const next = boxAfterPatch(b, t, patch)
    expect(next.centerX).toBeCloseTo(b.centerX)
    expect(next.centerY).toBeCloseTo(b.centerY)
    expect(next.flipX).toBe(true)
  })

  it('fit = contain, fill = cover, centred, flips kept', () => {
    const t = tf({ x: 300, scaleX: -0.2, scaleY: 0.2 })
    const src = image(1000, 1000)
    const b = visualBox(project, video, src, t)!
    // Square 1080×1080 base (contain-fit on a 16:9 frame).
    const fit = fitPatch(b, frame, 'fit')
    expect(fit.scaleX).toBeCloseTo(-1)
    expect(fit.scaleY).toBeCloseTo(1)
    const fitBox = boxAfterPatch(b, t, fit)
    expect(fitBox.centerX).toBeCloseTo(960)
    expect(fitBox.height).toBeCloseTo(1080)
    const fill = boxAfterPatch(b, t, fitPatch(b, frame, 'fill'))
    expect(fill.width).toBeCloseTo(1920)
    expect(fill.height).toBeCloseTo(1920)
    expect(fill.centerY).toBeCloseTo(540)
  })

  it('fit of a rotated object fits its rotated bounds', () => {
    const t = tf({ rotation: 90 })
    const b = box(t) // 1920×1080 rotated → 1080×1920 bounds
    const next = boxAfterPatch(b, t, fitPatch(b, frame, 'fit'))
    const bb = axisAlignedBounds(next)
    expect(bb.bottom - bb.top).toBeCloseTo(1080)
    expect(bb.left).toBeGreaterThanOrEqual(-1e-6)
  })

  it('reset clears position, scale, rotation and the anchor (opacity kept)', () => {
    const p = resetPatch()
    expect(p).toMatchObject({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 })
    expect('anchorX' in p && p.anchorX === undefined).toBe(true)
    expect('opacity' in p).toBe(false)
  })

  it('position presets move the bounds to the 9-point grid with a 5 % margin', () => {
    const bounds = { left: 100, top: 100, right: 300, bottom: 200 }
    expect(presetDelta(bounds, 'top-left', frame)).toEqual({ dx: -4, dy: -46 })
    const br = presetDelta(bounds, 'bottom-right', frame)
    expect(300 + br.dx).toBeCloseTo(1824)
    expect(200 + br.dy).toBeCloseTo(1026)
    const c = presetDelta(bounds, 'center', frame)
    expect(200 + c.dx).toBeCloseTo(960)
    expect(150 + c.dy).toBeCloseTo(540)
    const top = presetDelta(bounds, 'top', frame)
    expect(200 + top.dx).toBeCloseTo(960)
  })

  it('size with the aspect lock (default) / unlocked; signs kept', () => {
    const locked = sizePatch(
      1920,
      1080,
      { scaleX: -0.5, scaleY: 0.25 },
      { width: 1920 },
    )
    expect(locked.scaleX).toBeCloseTo(-1)
    expect(locked.scaleY).toBeCloseTo(0.5)
    const free = sizePatch(
      1920,
      1080,
      { scaleX: 0.5, scaleY: 0.25, lockAspect: false },
      { height: 540 },
    )
    expect(free.scaleX).toBeCloseTo(0.5)
    expect(free.scaleY).toBeCloseTo(0.5)
    expect(scaleFieldPatch({ scaleX: 1, scaleY: -2 }, 'scaleX', 2)).toEqual({
      scaleX: 2,
      scaleY: -4,
    })
    expect(
      scaleFieldPatch({ scaleX: 1, scaleY: 2, lockAspect: false }, 'scaleX', 2),
    ).toEqual({ scaleX: 2 })
  })
})
