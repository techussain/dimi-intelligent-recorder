import { describe, it, expect } from 'vitest'
import { alignDeltas, distributeDeltas, type LayoutItem } from '../align'
import { axisAlignedBounds } from '../geometry'

const frame = { w: 1000, h: 500 }

const item = (
  id: string,
  left: number,
  top: number,
  w: number,
  h: number,
): LayoutItem => ({
  id,
  bounds: { left, top, right: left + w, bottom: top + h },
})

const items = [item('a', 100, 50, 100, 50), item('b', 400, 200, 200, 100)]

function byId(list: { id: string; dx: number; dy: number }[]) {
  return Object.fromEntries(list.map((d) => [d.id, { dx: d.dx, dy: d.dy }]))
}

describe('alignDeltas', () => {
  it('aligns to the frame edges and centres', () => {
    expect(byId(alignDeltas(items, 'left', 'frame', frame))).toEqual({
      a: { dx: -100, dy: 0 },
      b: { dx: -400, dy: 0 },
    })
    expect(byId(alignDeltas(items, 'right', 'frame', frame))).toEqual({
      a: { dx: 800, dy: 0 },
      b: { dx: 400, dy: 0 },
    })
    expect(byId(alignDeltas(items, 'hcenter', 'frame', frame))).toEqual({
      a: { dx: 350, dy: 0 },
      b: { dx: 0, dy: 0 },
    })
    expect(byId(alignDeltas(items, 'top', 'frame', frame))).toEqual({
      a: { dx: 0, dy: -50 },
      b: { dx: 0, dy: -200 },
    })
    expect(byId(alignDeltas(items, 'vmiddle', 'frame', frame))).toEqual({
      a: { dx: 0, dy: 175 },
      b: { dx: 0, dy: 0 },
    })
    expect(byId(alignDeltas(items, 'bottom', 'frame', frame))).toEqual({
      a: { dx: 0, dy: 400 },
      b: { dx: 0, dy: 200 },
    })
  })

  it('aligns to the selection bounds', () => {
    // Selection bounds: left 100, right 600, top 50, bottom 300.
    expect(byId(alignDeltas(items, 'left', 'selection', frame))).toEqual({
      a: { dx: 0, dy: 0 },
      b: { dx: -300, dy: 0 },
    })
    expect(byId(alignDeltas(items, 'right', 'selection', frame))).toEqual({
      a: { dx: 400, dy: 0 },
      b: { dx: 0, dy: 0 },
    })
    expect(byId(alignDeltas(items, 'hcenter', 'selection', frame))).toEqual({
      a: { dx: 200, dy: 0 },
      b: { dx: -150, dy: 0 },
    })
    expect(byId(alignDeltas(items, 'bottom', 'selection', frame))).toEqual({
      a: { dx: 0, dy: 200 },
      b: { dx: 0, dy: 0 },
    })
  })

  it('uses the axis-aligned bounds of rotated boxes', () => {
    // 200×100 rotated 90° about (500, 250) → AABB 100 wide: left = 450.
    const rotated = {
      id: 'r',
      bounds: axisAlignedBounds({
        centerX: 500,
        centerY: 250,
        width: 200,
        height: 100,
        rotation: 90,
      }),
    }
    const [d] = alignDeltas([rotated], 'left', 'frame', frame)
    expect(d?.dx).toBeCloseTo(-450)
    const [t] = alignDeltas([rotated], 'top', 'frame', frame)
    expect(t?.dy).toBeCloseTo(-150)
  })

  it('no items → no deltas', () => {
    expect(alignDeltas([], 'left', 'selection', frame)).toEqual([])
  })
})

describe('distributeDeltas', () => {
  it('equalises horizontal gaps, keeping the first and last fixed', () => {
    const list = [
      item('a', 0, 0, 100, 10),
      item('c', 900, 0, 100, 10),
      item('b', 150, 0, 200, 10),
    ]
    // Span 0..1000, widths 400 → two gaps of 300; b goes to 400.
    expect(byId(distributeDeltas(list, 'h'))).toEqual({
      a: { dx: 0, dy: 0 },
      c: { dx: 0, dy: 0 },
      b: { dx: 250, dy: 0 },
    })
  })

  it('distributes vertically with 4 items', () => {
    const list = [
      item('a', 0, 0, 10, 10),
      item('b', 0, 20, 10, 10),
      item('c', 0, 30, 10, 10),
      item('d', 0, 90, 10, 10),
    ]
    // Span 0..100, heights 40 → gaps of 20: b at 30, c at 60.
    expect(byId(distributeDeltas(list, 'v'))).toEqual({
      a: { dx: 0, dy: 0 },
      b: { dx: 0, dy: 10 },
      c: { dx: 0, dy: 30 },
      d: { dx: 0, dy: 0 },
    })
  })

  it('needs at least 3 items', () => {
    expect(distributeDeltas(items, 'h')).toEqual([])
  })
})
