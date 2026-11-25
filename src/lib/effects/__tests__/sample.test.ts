/**
 * Effect sampling: zoom easing and adjacent-segment blending, out-of-range,
 * speed, Ken Burns, fades, spotlight/shake envelopes, crop clamps and the
 * deterministic shake noise.
 */
import { describe, it, expect } from 'vitest'
import { computeCrop, fadeGain, needsCrop, sampleEffects, sampleZoom } from '../sample'
import { shakeOffset, valueNoise } from '../shake'
import { ease } from '../easing'
import {
  createChromaKey,
  createFade,
  createKenBurns,
  createShake,
  createSpotlight,
  createZoom,
  normalizeEffect,
  type ClipEffect,
} from '../types'
import { clipSourceTime } from '../../compositor/scene'
import { effectTimelineRange, sourceToTimeline } from '../timing'
import { ease as keyframeEase } from '../../compositor/keyframes'
import type { Clip } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

function clip(effects: ClipEffect[], over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    sourceId: 's1',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 20,
    speed: 1,
    transform: { ...identityTransform },
    volume: 1,
    effects,
    ...over,
  }
}

/** Sample at timeline time t, the way drawScene does. */
function at(c: Clip, t: number, opts = {}) {
  return sampleEffects(c, t - c.timelineStart, clipSourceTime(c, t).time, opts)
}

describe('easing', () => {
  it('is shared with keyframes (one implementation)', () => {
    expect(keyframeEase).toBe(ease)
    expect(ease(0.5, 'ease-in-out')).toBeCloseTo(0.5)
    expect(ease(0.25, 'ease-in')).toBeCloseTo(0.0625)
  })
})

describe('zoom sampling', () => {
  const z = createZoom(2, 6, {
    scale: 2,
    focusX: 0.8,
    focusY: 0.2,
    easeIn: 1,
    easeOut: 1,
  })

  it('is identity outside the segment', () => {
    const c = clip([z])
    expect(at(c, 1).crop.scale).toBe(1)
    expect(at(c, 6.5).crop.scale).toBe(1)
  })

  it('eases in, holds, eases out', () => {
    const c = clip([z])
    expect(at(c, 2).crop.scale).toBeCloseTo(1)
    // Half-way through the 1 s ease-in: ease-in-out(0.5) = 0.5 → 1.5×.
    expect(at(c, 2.5).crop.scale).toBeCloseTo(1.5)
    expect(at(c, 2.25).crop.scale).toBeCloseTo(1 + ease(0.25, 'ease-in-out'))
    expect(at(c, 4).crop).toEqual({ scale: 2, fx: 0.8, fy: 0.2 })
    expect(at(c, 5.5).crop.scale).toBeCloseTo(1.5)
    // Focus stays on the target while zooming in from 1×.
    expect(at(c, 2.5).crop.fx).toBeCloseTo(0.8)
  })

  it('shrinks the ramps proportionally when they exceed the segment', () => {
    const short = normalizeEffect({ ...z, start: 0, end: 1, easeIn: 1, easeOut: 1 })
    const s = sampleZoom([short], 0.5)
    expect(s?.scale).toBeCloseTo(2) // peak right in the middle
  })

  it('pans between adjacent segments instead of zooming out', () => {
    const a = createZoom(0, 4, {
      scale: 2,
      focusX: 0.2,
      focusY: 0.2,
      easeIn: 1,
      easeOut: 1,
    })
    const b = createZoom(4.02, 8, {
      scale: 3,
      focusX: 0.8,
      focusY: 0.6,
      easeIn: 1,
      easeOut: 1,
    })
    const c = clip([b, a]) // unsorted on purpose
    // End of a: no zoom-out.
    expect(at(c, 3.9).crop.scale).toBeCloseTo(2)
    // The tiny gap holds a.
    expect(at(c, 4.01).crop.scale).toBeCloseTo(2)
    // Start of b continues from a (not from 1×).
    expect(at(c, 4.02).crop.scale).toBeCloseTo(2)
    expect(at(c, 4.02).crop.fx).toBeCloseTo(0.2)
    const mid = at(c, 4.52)
    expect(mid.crop.scale).toBeCloseTo(2.5)
    expect(mid.crop.fx).toBeCloseTo(0.5)
    expect(at(c, 6).crop).toEqual({ scale: 3, fx: 0.8, fy: 0.6 })
    // b zooms out normally at its end.
    expect(at(c, 7.5).crop.scale).toBeCloseTo(2)
  })

  it('zooms out and back in when segments are not adjacent', () => {
    const a = createZoom(0, 4, { easeIn: 1, easeOut: 1 })
    const b = createZoom(5, 8, { easeIn: 1, easeOut: 1 })
    expect(at(clip([a, b]), 4.5).crop.scale).toBe(1)
    expect(at(clip([a, b]), 3.5).crop.scale).toBeCloseTo(1.5)
  })

  it('ignores disabled zooms', () => {
    expect(at(clip([{ ...z, enabled: false }]), 4).crop.scale).toBe(1)
  })

  it('is anchored to source time: trim and speed move it on the timeline', () => {
    // Trimmed so source 2..6 is gone.
    expect(effectTimelineRange(clip([z], { sourceIn: 7 }), z)).toBeNull()
    // 2× speed: source 4 (fully zoomed) is at timeline 2.
    const fast = clip([z], { speed: 2, sourceOut: 20 })
    expect(at(fast, 2).crop.scale).toBe(2)
    expect(at(fast, 0.5).crop.scale).toBe(1)
    expect(sourceToTimeline(fast, 2)).toBe(1)
    expect(effectTimelineRange(fast, z)).toMatchObject({ start: 1, end: 3 })
    // Partly trimmed: visible part only.
    expect(
      effectTimelineRange(clip([z], { sourceIn: 3, timelineStart: 10 }), z),
    ).toEqual({
      start: 10,
      end: 13,
      clippedStart: true,
      clippedEnd: false,
    })
  })

  it('is skipped with suppressCamera (focus picking) but fades still apply', () => {
    const c = clip([z, createFade({ in: 1, out: 0 })])
    const s = at(c, 0.5, { suppressCamera: true })
    expect(s.crop.scale).toBe(1)
    expect(s.opacityMul).toBeCloseTo(0.5)
  })
})

describe('Ken Burns', () => {
  it('interpolates over normalized clip progress', () => {
    const kb = createKenBurns({
      fromScale: 1,
      toScale: 2,
      fromX: 0.2,
      toX: 0.8,
      fromY: 0.5,
      toY: 0.5,
    })
    const c = clip([kb], { sourceOut: 10, speed: 2 }) // 5 s on the timeline
    expect(at(c, 0).crop.scale).toBeCloseTo(1)
    expect(at(c, 2.5).crop).toEqual({ scale: 1.5, fx: 0.5, fy: 0.5 })
    expect(at(c, 5).crop.scale).toBeCloseTo(2, 2)
  })

  it('composes with a zoom (scales multiply)', () => {
    const kb = createKenBurns({ fromScale: 1.5, toScale: 1.5, fromX: 0.5, toX: 0.5 })
    const z = createZoom(0, 10, { scale: 2, easeIn: 0, easeOut: 0, focusX: 0.9 })
    const s = at(clip([kb, z]), 5)
    expect(s.crop.scale).toBeCloseTo(3)
    expect(s.crop.fx).toBeCloseTo(0.9)
  })
})

describe('fade', () => {
  it('ramps opacity and volume in and out', () => {
    const c = clip([createFade({ in: 1, out: 2 })], { sourceOut: 10 })
    expect(at(c, 0).opacityMul).toBe(0)
    expect(at(c, 0.5).opacityMul).toBeCloseTo(0.5)
    expect(at(c, 5).opacityMul).toBe(1)
    expect(at(c, 9).volumeMul).toBeCloseTo(0.5)
  })

  it('ignores edges owned by a transition', () => {
    const f = { in: 1, out: 1 }
    expect(fadeGain(f, 0.5, 10, { fadeIn: false })).toBe(1)
    expect(fadeGain(f, 9.5, 10, { fadeOut: false })).toBe(1)
    expect(fadeGain(f, 9.5, 10)).toBeCloseTo(0.5)
    const c = clip([createFade(f)], { sourceOut: 10 })
    expect(at(c, 0.5, { fadeIn: false }).opacityMul).toBe(1)
  })
})

describe('spotlight / shake / chroma', () => {
  it('spotlight ramps dim and blur in and out of its range', () => {
    const sp = createSpotlight(2, 6, { dim: 0.8, blur: 10 })
    const c = clip([sp])
    expect(at(c, 1).spotlight).toBeNull()
    expect(at(c, 2.15)?.spotlight?.dim).toBeCloseTo(0.4)
    expect(at(c, 4).spotlight).toMatchObject({ dim: 0.8, blur: 10, shape: 'ellipse' })
    expect(at(c, 6).spotlight).toBeNull()
  })

  it('shake is only active in range and needs a crop', () => {
    const sh = createShake(1, 3, { intensity: 10, frequency: 5 })
    const c = clip([sh])
    expect(at(c, 0.5).shake).toBeNull()
    const s = at(c, 2)
    expect(s.shake?.amp).toBe(10)
    expect(Math.abs(s.shake?.dx ?? 99)).toBeLessThanOrEqual(10)
    expect(needsCrop(s)).toBe(true)
  })

  it('passes chroma parameters through (rendered from Phase 2)', () => {
    const ck = createChromaKey({ color: '#00FF00' })
    expect(at(clip([ck]), 1).chroma).toEqual({
      color: '#00ff00',
      similarity: 0.4,
      smoothness: 0.08,
      spill: 0.1,
    })
  })

  it('returns the shared identity sample for a clip without effects', () => {
    const a = at(clip([]), 1)
    expect(a).toBe(at(clip([]), 2))
    expect(needsCrop(a)).toBe(false)
  })
})

describe('computeCrop', () => {
  const none = null

  it('centres the viewport on the focus point', () => {
    const r = computeCrop(
      { crop: { scale: 2, fx: 0.5, fy: 0.5 }, shake: none },
      1000,
      500,
      1000,
      500,
    )
    expect(r).toEqual({ sx: 250, sy: 125, sw: 500, sh: 250 })
  })

  it('clamps the viewport inside the frame (no black edges)', () => {
    const tl = computeCrop(
      { crop: { scale: 2, fx: 0, fy: 0 }, shake: none },
      1000,
      500,
      1000,
      500,
    )
    expect(tl).toMatchObject({ sx: 0, sy: 0 })
    const br = computeCrop(
      { crop: { scale: 4, fx: 1, fy: 1 }, shake: none },
      1000,
      500,
      1000,
      500,
    )
    expect(br.sx).toBe(750)
    expect(br.sy).toBe(375)
    expect(br.sx + br.sw).toBe(1000)
  })

  it('never zooms out below 1×', () => {
    const r = computeCrop(
      { crop: { scale: 0.5, fx: 0.5, fy: 0.5 }, shake: none },
      800,
      600,
      800,
      600,
    )
    expect(r).toEqual({ sx: 0, sy: 0, sw: 800, sh: 600 })
  })

  it('shake forces a min zoom of 1 + 2·amp/box and stays in frame', () => {
    const r = computeCrop(
      { crop: { scale: 1, fx: 0.5, fy: 0.5 }, shake: { dx: 10, dy: -10, amp: 10 } },
      1000,
      1000,
      500,
      500,
    )
    const minZoom = 1 + (2 * 10) / 500
    expect(r.sw).toBeCloseTo(1000 / minZoom)
    // dx = +10 box px = +10·(sw/500) source px → right edge exactly.
    expect(r.sx).toBeCloseTo(1000 - r.sw)
    expect(r.sy).toBeCloseTo(0)
  })
})

describe('shake noise', () => {
  it('is deterministic for an effect id and time', () => {
    expect(shakeOffset('fx-a', 1.234, 8)).toEqual(shakeOffset('fx-a', 1.234, 8))
    expect(shakeOffset('fx-a', 1.234, 8)).not.toEqual(shakeOffset('fx-b', 1.234, 8))
    const c1 = clip([{ ...createShake(0, 5), id: 'same' }])
    const c2 = clip([{ ...createShake(0, 5), id: 'same' }])
    expect(at(c1, 2.5).shake).toEqual(at(c2, 2.5).shake)
  })

  it('stays within [-1, 1] and is continuous', () => {
    let prev = valueNoise(42, 0)
    for (let i = 1; i < 2000; i++) {
      const v = valueNoise(42, i * 0.01)
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(Math.abs(v - prev)).toBeLessThan(0.2)
      prev = v
    }
  })
})
