/** Shape drawing (rect radius, ellipse, line, arrow), limits, drawScene shape branch and blend modes. */
import { describe, it, expect } from 'vitest'
import { arrowHead, defaultShape, drawShape, normalizeShape } from '..'
import {
  createMockContext,
  nonFinite,
  type Call,
} from '../../elements/__tests__/mockContext'
import { buildScene, drawScene, fitView, shapeBaseBox } from '../../compositor/scene'
import type { Clip, MediaSource, Project, ShapeInfo, Track } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'
import { visualBox } from '../../layout/geometry'

const named = (calls: Call[], name: string) => calls.filter((c) => c[0] === name)

describe('drawShape', () => {
  it('draws a rounded rect with the radius scaled to the box and the stroke inset', () => {
    const { ctx, calls, depth } = createMockContext()
    const s: ShapeInfo = { ...defaultShape('rect'), strokeWidth: 10, radius: 40 }
    // Box twice the intrinsic size: radius 80, stroke 20 (inset by 10).
    drawShape(ctx, s, { w: s.width * 2, h: s.height * 2 })
    expect(depth()).toBe(0)
    const arcs = named(calls, 'arcTo')
    expect(arcs).toHaveLength(4)
    for (const a of arcs) expect(a[5]).toBeCloseTo(80 - 10)
    expect(calls).toContainEqual(['set:fillStyle', s.fill])
    expect(calls).toContainEqual(['set:lineWidth', 20])
    expect(named(calls, 'fill')).toHaveLength(1)
    expect(named(calls, 'stroke')).toHaveLength(1)
    // Path starts inside the box by half the stroke.
    const move = named(calls, 'moveTo')[0]!
    expect(move[2]).toBeCloseTo(-s.height + 10)
    expect(nonFinite(calls)).toEqual([])
  })

  it('clamps the radius to half the smaller side and uses rect() for radius 0', () => {
    const { ctx, calls } = createMockContext()
    drawShape(ctx, { ...defaultShape('rect'), radius: 5000 }, { w: 100, h: 50 })
    for (const a of named(calls, 'arcTo')) expect(a[5]).toBeCloseTo(25 * 1)
    const m2 = createMockContext()
    drawShape(m2.ctx, { ...defaultShape('rect'), radius: 0 }, { w: 100, h: 50 })
    expect(named(m2.calls, 'rect')).toEqual([['rect', -50, -25, 100, 50]])
    expect(named(m2.calls, 'stroke')).toHaveLength(0) // strokeWidth 0
  })

  it('draws an ellipse filling the box; "no fill" paints only the outline', () => {
    const { ctx, calls } = createMockContext()
    drawShape(
      ctx,
      { ...defaultShape('ellipse'), fill: 'transparent', strokeWidth: 4 },
      {
        w: 320,
        h: 160,
      },
    )
    const e = named(calls, 'ellipse')[0]!
    // Stroke scales by the geometric mean of the axis scales (1 and 0.5).
    const lw = 4 * Math.SQRT1_2
    expect(e[3]).toBeCloseTo((320 - lw) / 2)
    expect(e[4]).toBeCloseTo((160 - lw) / 2)
    expect(named(calls, 'fill')).toHaveLength(0)
    expect(named(calls, 'stroke')).toHaveLength(1)
  })

  it('draws a line across the box centre with round caps kept inside', () => {
    const { ctx, calls } = createMockContext()
    const s = defaultShape('line') // 600 × 24, stroke 8
    drawShape(ctx, s, { w: 600, h: 24 })
    expect(calls).toContainEqual(['set:lineCap', 'round'])
    expect(named(calls, 'moveTo')).toEqual([['moveTo', -296, 0]])
    expect(named(calls, 'lineTo')).toEqual([['lineTo', 296, 0]])
    expect(calls).toContainEqual(['set:strokeStyle', s.stroke])
    expect(named(calls, 'fill')).toHaveLength(0)
  })

  it('draws an arrow whose head scales with the stroke width', () => {
    const head = (sw: number) => {
      const { ctx, calls } = createMockContext()
      drawShape(ctx, { ...defaultShape('arrow'), strokeWidth: sw }, { w: 600, h: 80 })
      const tri = named(calls, 'lineTo').slice(-2)
      const tip = named(calls, 'moveTo').at(-1)!
      expect(tip.slice(1)).toEqual([300, 0])
      expect(named(calls, 'fill')).toHaveLength(1)
      return {
        length: 300 - (tri[0]![1] as number),
        half: Math.abs(tri[0]![2] as number),
      }
    }
    const thin = head(4)
    const thick = head(12)
    expect(thick.length).toBeGreaterThan(thin.length)
    expect(thick.half).toBeGreaterThan(thin.half)
    expect(thick).toEqual(arrowHead(12, 600, 80))
    // The head never leaves the box vertically.
    expect(head(100).half).toBeLessThanOrEqual(40)
  })

  it('normalizeShape clamps sizes, stroke and radius', () => {
    const n = normalizeShape({
      type: 'rect',
      fill: '#fff',
      stroke: '#000',
      strokeWidth: -3,
      radius: 999,
      width: 0,
      height: Number.NaN,
    })
    expect(n).toMatchObject({ strokeWidth: 0, width: 1, height: 100, radius: 0.5 })
  })
})

// ── drawScene ───────────────────────────────────────────────────────────────

const track = (id: string, kind: Track['kind']): Track => ({
  id,
  kind,
  name: id,
  muted: false,
  locked: false,
  height: 40,
})

function shapeSource(id: string, shape: ShapeInfo): MediaSource {
  return {
    id,
    kind: 'shape',
    opfsPath: '',
    mimeType: 'application/x-shape',
    duration: 5,
    width: shape.width,
    height: shape.height,
    createdAt: 0,
    name: id,
    shape,
  }
}

const clip = (
  id: string,
  trackId: string,
  sourceId: string,
  over: Partial<Clip> = {},
): Clip => ({
  id,
  trackId,
  sourceId,
  timelineStart: 0,
  sourceIn: 0,
  sourceOut: 5,
  speed: 1,
  transform: { ...identityTransform },
  volume: 0,
  ...over,
})

function project(tracks: Track[], sources: MediaSource[], clips: Clip[]): Project {
  return {
    id: 'p',
    name: 'p',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks,
    clips,
    transitions: [],
    sources,
    duration: 5,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('drawScene shape branch', () => {
  it('draws the shape vectorially in its placed box (no getImage) and matches visualBox', () => {
    const s = defaultShape('ellipse')
    const src = shapeSource('s', s)
    const p = project(
      [track('ov', 'overlay')],
      [src],
      [
        clip('c', 'ov', 's', {
          transform: { ...identityTransform, x: 100, scaleX: 2 },
        }),
      ],
    )
    const { ctx, calls, depth } = createMockContext()
    const view = fitView(1920, 1080, 960, 540)
    const getImage = () => {
      throw new Error('shapes need no image')
    }
    drawScene(ctx, p, 1, buildScene(p, 1, { includeLive: false }), getImage, view)
    expect(depth()).toBe(0)
    const e = named(calls, 'ellipse')[0]!
    // 320 px authored at 1080p → 320 × 2 wide, 320 high (project px).
    expect(e[3]).toBeCloseTo(320)
    expect(e[4]).toBeCloseTo(160)
    const base = shapeBaseBox(1920, 1080, src)
    expect(base).toEqual({ cx: 960, cy: 540, w: 320, h: 320 })
    const box = visualBox(p, p.tracks[0]!, src, p.clips[0]!.transform)!
    expect(box.width).toBeCloseTo(640)
    expect(box.height).toBeCloseTo(320)
    expect(box.left + box.width / 2).toBeCloseTo(960 + 100)
  })

  it('skips shape sources without shape data', () => {
    const src = { ...shapeSource('s', defaultShape('rect')) }
    delete src.shape
    const p = project([track('ov', 'overlay')], [src], [clip('c', 'ov', 's')])
    expect(buildScene(p, 1, { includeLive: false })).toEqual([])
  })
})

describe('blend modes in drawScene', () => {
  function run(blend: Clip['blendMode']) {
    const p = project(
      [track('ov', 'overlay'), track('v', 'video')],
      [
        shapeSource('a', defaultShape('rect')),
        shapeSource('b', defaultShape('ellipse')),
      ],
      [
        clip('top', 'ov', 'a', blend ? { blendMode: blend } : {}),
        clip('bottom', 'v', 'b'),
      ],
    )
    const m = createMockContext()
    drawScene(
      m.ctx,
      p,
      1,
      buildScene(p, 1, { includeLive: false }),
      () => null,
      fitView(1920, 1080, 1920, 1080),
    )
    return m
  }

  it('sets globalCompositeOperation for the blended layer only, inside save/restore', () => {
    const { calls, depth } = run('multiply')
    const sets = calls.filter((c) => c[0] === 'set:globalCompositeOperation')
    expect(sets).toEqual([['set:globalCompositeOperation', 'multiply']])
    // Set after the bottom layer's ellipse and before the top layer's rect.
    const iSet = calls.findIndex((c) => c[0] === 'set:globalCompositeOperation')
    const iEllipse = calls.findIndex((c) => c[0] === 'ellipse')
    const iRect = calls.findIndex((c) => c[0] === 'arcTo')
    expect(iEllipse).toBeLessThan(iSet)
    expect(iSet).toBeLessThan(iRect)
    expect(depth()).toBe(0)
    // Inside the layer's save/restore: a save precedes it, a restore follows.
    const lastSave = calls
      .slice(0, iSet)
      .map((c) => c[0])
      .lastIndexOf('save')
    expect(lastSave).toBeGreaterThan(iEllipse)
    expect(calls.slice(iRect).some((c) => c[0] === 'restore')).toBe(true)
  })

  it('leaves the composite operation alone for normal / absent blend modes', () => {
    for (const b of ['normal', undefined] as const) {
      const { calls } = run(b)
      expect(calls.some((c) => c[0] === 'set:globalCompositeOperation')).toBe(false)
    }
  })

  it('applies to media layers too', () => {
    const img = document.createElement('canvas')
    img.width = 160
    img.height = 90
    const p = project(
      [track('v', 'video')],
      [
        {
          id: 'img',
          kind: 'image',
          opfsPath: 'a.png',
          mimeType: 'image/png',
          duration: 0,
          width: 160,
          height: 90,
          createdAt: 0,
          name: 'a',
        },
      ],
      [clip('c', 'v', 'img', { blendMode: 'screen' })],
    )
    const m = createMockContext()
    drawScene(
      m.ctx,
      p,
      1,
      buildScene(p, 1, { includeLive: false }),
      () => img,
      fitView(1920, 1080, 1920, 1080),
    )
    const iSet = m.calls.findIndex((c) => c[0] === 'set:globalCompositeOperation')
    const iDraw = m.calls.findIndex((c) => c[0] === 'drawImage')
    expect(m.calls[iSet]).toEqual(['set:globalCompositeOperation', 'screen'])
    expect(iSet).toBeLessThan(iDraw)
  })
})
