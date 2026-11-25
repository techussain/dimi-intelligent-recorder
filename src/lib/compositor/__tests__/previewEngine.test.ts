/**
 * Clip duration edge cases for the compositor.
 *
 * Verifies clipDurationSec/clipEndSec across edge-case speed values and
 * sourceIn/sourceOut combinations so the compositor never sees negative or
 * non-finite values.
 */
import { describe, it, expect } from 'vitest'
import { clipDurationSec, clipEndSec } from '../../timeline/selectors'
import type { Clip } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

// ─── helpers ─────────────────────────────────────────────────────────────────

function clip(
  timelineStart: number,
  sourceIn: number,
  sourceOut: number,
  speed: number,
): Clip {
  return {
    id: 'c',
    trackId: 't',
    sourceId: 's',
    timelineStart,
    sourceIn,
    sourceOut,
    speed,
    transform: { ...identityTransform },
    volume: 1,
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('compositor clip duration edge cases', () => {
  it('speed = 1.0 — identity', () => {
    expect(clipDurationSec(clip(0, 0, 10, 1))).toBe(10)
    expect(clipEndSec(clip(5, 0, 10, 1))).toBe(15)
  })

  it('speed = 0.1 — slow motion, duration 10× longer', () => {
    const dur = clipDurationSec(clip(0, 0, 1, 0.1))
    expect(dur).toBeCloseTo(10, 5)
    expect(Number.isFinite(dur)).toBe(true)
  })

  it('speed = 16 — max fast-forward, duration 1/16th', () => {
    const dur = clipDurationSec(clip(0, 0, 16, 16))
    expect(dur).toBe(1)
  })

  it('speed = 0 — clamped, no division by zero', () => {
    const dur = clipDurationSec(clip(0, 0, 10, 0))
    expect(Number.isFinite(dur)).toBe(true)
    expect(dur).toBeGreaterThan(0)
  })

  it('speed < 0 (negative) — treated as very slow, duration > 0', () => {
    // Math.max(0.1, negative) = 0.1
    const dur = clipDurationSec(clip(0, 0, 5, -1))
    expect(Number.isFinite(dur)).toBe(true)
    expect(dur).toBeGreaterThan(0)
  })

  it('sourceIn === sourceOut — zero-duration clip', () => {
    expect(clipDurationSec(clip(0, 7, 7, 1))).toBe(0)
    expect(clipEndSec(clip(3, 7, 7, 1))).toBe(3)
  })

  it('sourceIn > sourceOut — negative range clamped to zero', () => {
    expect(clipDurationSec(clip(0, 10, 5, 1))).toBe(0)
  })

  it('very large source range — finite result', () => {
    const dur = clipDurationSec(clip(0, 0, 3600, 1))
    expect(dur).toBe(3600)
    expect(Number.isFinite(dur)).toBe(true)
  })

  it('fractional speed — no floating-point infinity', () => {
    const speeds = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16] as const
    for (const s of speeds) {
      const dur = clipDurationSec(clip(0, 0, 10, s))
      expect(Number.isFinite(dur)).toBe(true)
      expect(dur).toBeGreaterThanOrEqual(0)
    }
  })

  it('clipEndSec never less than timelineStart', () => {
    // zero-duration clip: end should equal start
    expect(clipEndSec(clip(5, 3, 3, 1))).toBe(5)
  })
})
