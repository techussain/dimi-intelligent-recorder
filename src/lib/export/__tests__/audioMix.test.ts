/**
 * Windowed export mix: the part of each clip that falls into a window, and
 * the transition-fade automation carried across window boundaries.
 */
import { describe, it, expect } from 'vitest'
import { clipWindow, fadeGainAt, fadeOpsInWindow, WINDOW_SEC } from '../audioMix'

describe('clipWindow', () => {
  const plan = { start: 10, stop: 70, offset: 5 } // 60 s clip, source from 5 s

  it('returns the clip span inside the window with matching source times', () => {
    expect(clipWindow(plan, 1, 0, 30)).toEqual({ a: 10, b: 30, srcFrom: 5, srcTo: 25 })
    expect(clipWindow(plan, 1, 30, 60)).toEqual({
      a: 30,
      b: 60,
      srcFrom: 25,
      srcTo: 55,
    })
    expect(clipWindow(plan, 1, 60, 90)).toEqual({
      a: 60,
      b: 70,
      srcFrom: 55,
      srcTo: 65,
    })
  })

  it('consecutive windows cover the clip exactly once, without gaps', () => {
    let covered = 0
    let lastSrc = plan.offset
    for (let w0 = 0; w0 < 100; w0 += WINDOW_SEC) {
      const w = clipWindow(plan, 1, w0, w0 + WINDOW_SEC)
      if (!w) continue
      expect(w.srcFrom).toBeCloseTo(lastSrc)
      lastSrc = w.srcTo
      covered += w.b - w.a
    }
    expect(covered).toBeCloseTo(60)
  })

  it('scales source time by speed', () => {
    expect(clipWindow(plan, 2, 0, 30)).toEqual({ a: 10, b: 30, srcFrom: 5, srcTo: 45 })
  })

  it('is null when the clip is outside the window', () => {
    expect(clipWindow(plan, 1, 70, 100)).toBeNull()
    expect(clipWindow(plan, 1, 0, 10)).toBeNull()
  })
})

describe('fade automation across windows', () => {
  // Fade in over 9–11 s, fade out over 29–31 s (straddles the 30 s boundary).
  const fades = [
    { t0: 9, v0: 0, t1: 11, v1: 1 },
    { t0: 29, v0: 1, t1: 31, v1: 0 },
  ]

  it('fadeGainAt interpolates inside a fade and holds after it', () => {
    expect(fadeGainAt(fades, 5)).toBe(1)
    expect(fadeGainAt(fades, 10)).toBeCloseTo(0.5)
    expect(fadeGainAt(fades, 20)).toBe(1)
    expect(fadeGainAt(fades, 30)).toBeCloseTo(0.5)
    expect(fadeGainAt(fades, 40)).toBe(0)
  })

  it('a fade cut by a window edge continues from the right value', () => {
    const first = fadeOpsInWindow(fades, 9, 30, 0)
    expect(first.at(-1)).toEqual({ kind: 'ramp', value: 0.5, at: 30 })
    const second = fadeOpsInWindow(fades, 30, 31, 30)
    expect(second[0]).toEqual({ kind: 'set', value: 0.5, at: 0 })
    expect(second.at(-1)).toEqual({ kind: 'ramp', value: 0, at: 1 })
  })
})
