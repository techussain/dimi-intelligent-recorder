import { describe, it, expect } from 'vitest'
import {
  buildFrameTimeline,
  clampFrameDelay,
  frameIndexAt,
  loopsFromRepetitionCount,
  nearestAvailableFrame,
  onDemandCapacity,
  PREFETCH_AHEAD,
  probeAnimatedImage,
  shouldPredecode,
} from '../animatedImage'

describe('clampFrameDelay', () => {
  it('replaces delays of 10 ms or less with 100 ms, like browsers', () => {
    expect(clampFrameDelay(0)).toBe(0.1)
    expect(clampFrameDelay(0.01)).toBe(0.1)
    expect(clampFrameDelay(10_000 / 1e6)).toBe(0.1)
    expect(clampFrameDelay(null)).toBe(0.1)
    expect(clampFrameDelay(Number.NaN)).toBe(0.1)
  })
  it('keeps real delays', () => {
    expect(clampFrameDelay(0.02)).toBe(0.02)
    expect(clampFrameDelay(0.011)).toBe(0.011)
    expect(clampFrameDelay(1.5)).toBe(1.5)
  })
})

describe('buildFrameTimeline', () => {
  it('accumulates clamped delays', () => {
    const tl = buildFrameTimeline([0.05, 0, 0.2, null])
    expect(tl.durations).toEqual([0.05, 0.1, 0.2, 0.1])
    expect(tl.starts[0]).toBe(0)
    expect(tl.starts[1]).toBeCloseTo(0.05)
    expect(tl.starts[2]).toBeCloseTo(0.15)
    expect(tl.starts[3]).toBeCloseTo(0.35)
    expect(tl.total).toBeCloseTo(0.45)
  })
})

describe('frameIndexAt', () => {
  const tl = buildFrameTimeline([0.1, 0.2, 0.3]) // starts 0, .1, .3; total .6
  it('finds the frame showing at t', () => {
    expect(frameIndexAt(tl, 0, false)).toBe(0)
    expect(frameIndexAt(tl, 0.099, false)).toBe(0)
    expect(frameIndexAt(tl, 0.1, false)).toBe(1)
    expect(frameIndexAt(tl, 0.29, false)).toBe(1)
    expect(frameIndexAt(tl, 0.3, false)).toBe(2)
  })
  it('holds the last frame past the end and the first before 0', () => {
    expect(frameIndexAt(tl, 0.6, false)).toBe(2)
    expect(frameIndexAt(tl, 10, false)).toBe(2)
    expect(frameIndexAt(tl, -1, false)).toBe(0)
  })
  it('wraps when looping', () => {
    expect(frameIndexAt(tl, 0.6, true)).toBe(0)
    expect(frameIndexAt(tl, 0.75, true)).toBe(1)
    expect(frameIndexAt(tl, 6.35, true)).toBe(2) // 6.35 mod .6 = .35
  })
  it('wraps negative times when looping', () => {
    expect(frameIndexAt(tl, -0.1, true)).toBe(2) // .5
    expect(frameIndexAt(tl, -0.55, true)).toBe(0) // .05
  })
  it('handles single-frame and empty timelines', () => {
    expect(frameIndexAt(buildFrameTimeline([0.5]), 3, true)).toBe(0)
    expect(frameIndexAt(buildFrameTimeline([]), 3, true)).toBe(0)
  })
})

describe('nearestAvailableFrame', () => {
  const have = (set: number[]) => (i: number) => set.includes(i)
  it('returns the target when available', () => {
    expect(nearestAvailableFrame(5, have([5, 6]), 10, false)).toBe(5)
  })
  it('prefers the earlier frame on ties', () => {
    expect(nearestAvailableFrame(5, have([4, 6]), 10, false)).toBe(4)
    expect(nearestAvailableFrame(5, have([3, 6]), 10, false)).toBe(6)
  })
  it('wraps around only when looping', () => {
    expect(nearestAvailableFrame(0, have([9, 3]), 10, true)).toBe(9)
    expect(nearestAvailableFrame(0, have([9, 3]), 10, false)).toBe(3)
  })
  it('returns -1 when nothing is decoded', () => {
    expect(nearestAvailableFrame(2, have([]), 10, true)).toBe(-1)
    expect(nearestAvailableFrame(0, have([]), 0, true)).toBe(-1)
  })
})

describe('memory budget', () => {
  it('pre-decodes up to 256 MB of RGBA frames', () => {
    expect(shouldPredecode(480, 270, 300)).toBe(true) // ~155 MB
    expect(shouldPredecode(1920, 1080, 40)).toBe(false) // ~332 MB
    expect(shouldPredecode(1024, 1024, 64)).toBe(true) // exactly 256 MB
    expect(shouldPredecode(1024, 1024, 65)).toBe(false)
  })
  it('sizes the on-demand LRU from its budget, never below the prefetch window', () => {
    expect(onDemandCapacity(1920, 1080)).toBe(
      Math.floor((64 * 1024 * 1024) / (1920 * 1080 * 4)),
    )
    expect(onDemandCapacity(8000, 8000)).toBe(PREFETCH_AHEAD + 2)
  })
})

describe('loop flag', () => {
  it('maps ImageTrack.repetitionCount', () => {
    expect(loopsFromRepetitionCount(Infinity)).toBe(true)
    expect(loopsFromRepetitionCount(3)).toBe(true)
    expect(loopsFromRepetitionCount(0)).toBe(false)
  })
})

describe('probeAnimatedImage without WebCodecs', () => {
  it('returns null (caller treats the file as a still image)', async () => {
    expect(typeof ImageDecoder).toBe('undefined')
    expect(
      await probeAnimatedImage(new Blob([new Uint8Array(4)]), 'image/gif'),
    ).toBeNull()
  })
})
