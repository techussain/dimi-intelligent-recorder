import { describe, it, expect } from 'vitest'
import { buildSnapTargets, computeSnap, snapValue, type SnapTargets } from '../snap'

const frame = { w: 1920, h: 1080 }

describe('computeSnap', () => {
  const targets: SnapTargets = {
    x: [
      { pos: 0, kind: 'frame' },
      { pos: 960, kind: 'center' },
    ],
    y: [{ pos: 540, kind: 'center' }],
  }

  it('snaps the centre to a line within the threshold and reports guides', () => {
    // Centre at (964, 537): 4 px / 3 px off the centre lines.
    const res = computeSnap(
      { left: 914, right: 1014, top: 487, bottom: 587 },
      targets,
      6,
    )
    expect(res.dx).toBeCloseTo(-4)
    expect(res.dy).toBeCloseTo(3)
    expect(res.guides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ axis: 'x', pos: 960, kind: 'center' }),
        expect.objectContaining({ axis: 'y', pos: 540, kind: 'center' }),
      ]),
    )
  })

  it('does not snap beyond the threshold', () => {
    const res = computeSnap(
      { left: 920, right: 1020, top: 400, bottom: 450 },
      targets,
      6,
    )
    expect(res.dx).toBe(0)
    expect(res.dy).toBe(0)
    expect(res.guides).toEqual([])
  })

  it('picks the nearest line among edges and centre', () => {
    const res = computeSnap(
      { left: 3, right: 103, top: 0, bottom: 10 },
      {
        x: [
          { pos: 0, kind: 'frame' },
          { pos: 105, kind: 'object' },
        ],
        y: [],
      },
      6,
    )
    // left→0 is 3 px, right→105 is 2 px: the right edge wins.
    expect(res.dx).toBeCloseTo(2)
    expect(res.guides.map((g) => g.pos)).toEqual([105])
  })

  it('object guides span both objects', () => {
    const t = buildSnapTargets(frame, [
      { left: 100, top: 600, right: 300, bottom: 700 },
    ])
    const res = computeSnap({ left: 102, right: 202, top: 100, bottom: 200 }, t, 6)
    expect(res.dx).toBeCloseTo(-2)
    const g = res.guides.find((x) => x.kind === 'object' && x.axis === 'x')
    expect(g).toMatchObject({ pos: 100, from: 100, to: 700 })
  })
})

describe('buildSnapTargets', () => {
  it('has frame edges, centre and safe margins', () => {
    const t = buildSnapTargets(frame, [])
    const xs = t.x.map((l) => l.pos).sort((a, b) => a - b)
    expect(xs).toEqual([0, 96, 192, 960, 1728, 1824, 1920])
    expect(t.y.some((l) => l.pos === 540 && l.kind === 'center')).toBe(true)
  })
})

describe('snapValue', () => {
  it('snaps within the threshold only', () => {
    const lines = [{ pos: 100, kind: 'frame' as const }]
    expect(snapValue(104, lines, 6)?.value).toBe(100)
    expect(snapValue(107, lines, 6)).toBeNull()
  })
})
