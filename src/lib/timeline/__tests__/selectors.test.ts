/**
 * Timeline selectors.
 *
 * Covers clipsAt, activeAt, clipDurationSec, and clipEndSec with:
 * boundary conditions, overlapping clips, live clips, speed ≠ 1, empty tracks.
 */
import { describe, it, expect } from 'vitest'
import { clipDurationSec, clipEndSec, clipsAt, activeAt, topClipAt } from '../selectors'
import type { Clip, Project } from '../types'
import { identityTransform } from '../types'

// ─── helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0
function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: `c${++_idCounter}`,
    trackId: 't1',
    sourceId: 's1',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 10,
    speed: 1,
    transform: { ...identityTransform },
    volume: 1,
    ...overrides,
  }
}

function makeProject(clips: Clip[]): Project {
  return {
    id: 'p1',
    name: 'Test',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: 't1', kind: 'video', name: 'V1', muted: false, locked: false, height: 72 },
    ],
    clips,
    transitions: [],
    sources: [],
    duration: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

// ─── clipDurationSec ─────────────────────────────────────────────────────────

describe('clipDurationSec', () => {
  it('speed = 1: duration equals source range', () => {
    expect(clipDurationSec(makeClip({ sourceIn: 0, sourceOut: 10, speed: 1 }))).toBe(10)
  })

  it('speed = 2: duration is halved', () => {
    expect(clipDurationSec(makeClip({ sourceIn: 0, sourceOut: 10, speed: 2 }))).toBe(5)
  })

  it('speed = 0.1: duration is 10×', () => {
    expect(
      clipDurationSec(makeClip({ sourceIn: 0, sourceOut: 1, speed: 0.1 })),
    ).toBeCloseTo(10)
  })

  it('speed = 16: duration is 1/16th of source range', () => {
    expect(clipDurationSec(makeClip({ sourceIn: 0, sourceOut: 16, speed: 16 }))).toBe(1)
  })

  it('sourceIn === sourceOut: zero-duration clip', () => {
    expect(clipDurationSec(makeClip({ sourceIn: 5, sourceOut: 5, speed: 1 }))).toBe(0)
  })

  it('inverted sourceIn/sourceOut: clamped to zero (never negative)', () => {
    expect(clipDurationSec(makeClip({ sourceIn: 10, sourceOut: 5, speed: 1 }))).toBe(0)
  })

  it('speed near zero is clamped so no division by zero', () => {
    // The function uses Math.max(0.1, speed) so speed=0 behaves like speed=0.1
    const c = makeClip({ sourceIn: 0, sourceOut: 10, speed: 0 })
    // With clamping: 10 / 0.1 = 100
    expect(clipDurationSec(c)).toBeGreaterThan(0)
    expect(Number.isFinite(clipDurationSec(c))).toBe(true)
  })
})

// ─── clipEndSec ──────────────────────────────────────────────────────────────

describe('clipEndSec', () => {
  it('returns timelineStart + duration', () => {
    const c = makeClip({ timelineStart: 3, sourceIn: 0, sourceOut: 5, speed: 1 })
    expect(clipEndSec(c)).toBe(8)
  })

  it('accounts for speed in end position', () => {
    // speed=2 → 10s source plays in 5s; starts at t=0 → ends at t=5
    const c = makeClip({ timelineStart: 0, sourceIn: 0, sourceOut: 10, speed: 2 })
    expect(clipEndSec(c)).toBe(5)
  })
})

// ─── clipsAt ─────────────────────────────────────────────────────────────────

describe('clipsAt', () => {
  it('returns clips whose range includes the given time', () => {
    const c1 = makeClip({ id: 'c1', timelineStart: 0, sourceOut: 5 })
    const c2 = makeClip({ id: 'c2', timelineStart: 3, sourceOut: 5 })
    const project = makeProject([c1, c2])

    expect(clipsAt(project, 2).map((c) => c.id)).toContain('c1')
    expect(clipsAt(project, 2).map((c) => c.id)).not.toContain('c2')

    const both = clipsAt(project, 4)
    expect(both.map((c) => c.id)).toContain('c1')
    expect(both.map((c) => c.id)).toContain('c2')
  })

  it('end boundary is exclusive', () => {
    // clip: t=0..5, clipEnd=5 → exclusive, so t=5 is NOT in range
    const project = makeProject([
      makeClip({ id: 'c-end', timelineStart: 0, sourceOut: 5 }),
    ])
    expect(clipsAt(project, 4.999)).toHaveLength(1)
    expect(clipsAt(project, 5.0)).toHaveLength(0)
  })

  it('start boundary is inclusive', () => {
    const project = makeProject([
      makeClip({ id: 'c-start', timelineStart: 2, sourceOut: 5 }),
    ])
    expect(clipsAt(project, 2.0)).toHaveLength(1)
    expect(clipsAt(project, 1.999)).toHaveLength(0)
  })

  it('returns empty array when no clips active', () => {
    const project = makeProject([makeClip({ timelineStart: 5, sourceOut: 5 })])
    expect(clipsAt(project, 0)).toHaveLength(0)
  })

  it('handles speed ≠ 1 end boundary correctly', () => {
    // speed=2, sourceOut=10 → duration=5 → ends at t=5
    const project = makeProject([
      makeClip({ id: 'fast', timelineStart: 0, sourceIn: 0, sourceOut: 10, speed: 2 }),
    ])
    expect(clipsAt(project, 4.999)).toHaveLength(1)
    expect(clipsAt(project, 5.0)).toHaveLength(0)
  })

  it('live clips (isLive=true) are included like normal clips', () => {
    const project = makeProject([
      makeClip({ id: 'live', timelineStart: 0, sourceOut: 999, isLive: true }),
    ])
    expect(clipsAt(project, 500)).toHaveLength(1)
  })
})

// ─── activeAt ────────────────────────────────────────────────────────────────

describe('activeAt', () => {
  it('returns undefined when the track has no clips at the time', () => {
    const project = makeProject([
      makeClip({ trackId: 't1', timelineStart: 5, sourceOut: 5 }),
    ])
    expect(activeAt(project, 0, 't1')).toBeUndefined()
  })

  it('returns the active clip on the given track', () => {
    const c = makeClip({ id: 'a', trackId: 't1', timelineStart: 0, sourceOut: 5 })
    const project = makeProject([c])
    expect(activeAt(project, 2, 't1')?.id).toBe('a')
  })

  it('returns undefined for a different trackId', () => {
    const c = makeClip({ id: 'a', trackId: 't1', timelineStart: 0, sourceOut: 5 })
    const project = makeProject([c])
    expect(activeAt(project, 2, 't2')).toBeUndefined()
  })

  it('returns the later-starting clip when two overlap on the same track', () => {
    // activeAt picks the clip with the highest timelineStart (most recent overlap)
    const c1 = makeClip({ id: 'early', trackId: 't1', timelineStart: 0, sourceOut: 10 })
    const c2 = makeClip({ id: 'late', trackId: 't1', timelineStart: 3, sourceOut: 10 })
    const project = makeProject([c1, c2])
    expect(activeAt(project, 5, 't1')?.id).toBe('late')
  })

  it('returns undefined on empty project', () => {
    const project = makeProject([])
    expect(activeAt(project, 0, 't1')).toBeUndefined()
  })
})

// ─── topClipAt ───────────────────────────────────────────────────────────────

describe('topClipAt', () => {
  it('picks the latest-starting covering clip', () => {
    const project = makeProject([
      makeClip({ id: 'early', timelineStart: 0, sourceOut: 10 }),
      makeClip({ id: 'late', timelineStart: 3, sourceOut: 10 }),
    ])
    expect(topClipAt(project, 't1', 5)?.id).toBe('late')
    expect(topClipAt(project, 't1', 1)?.id).toBe('early')
  })

  it('breaks start-time ties in favour of the clip later in the array', () => {
    const project = makeProject([
      makeClip({ id: 'first', timelineStart: 2, sourceOut: 10 }),
      makeClip({ id: 'second', timelineStart: 2, sourceOut: 10 }),
    ])
    expect(topClipAt(project, 't1', 4)?.id).toBe('second')
  })

  it('skips live clips unless includeLive is set, exposing the clip below', () => {
    const project = makeProject([
      makeClip({ id: 'base', timelineStart: 0, sourceOut: 10 }),
      makeClip({ id: 'live', timelineStart: 2, sourceOut: 10, isLive: true }),
    ])
    expect(topClipAt(project, 't1', 4)?.id).toBe('base')
    expect(topClipAt(project, 't1', 4, { includeLive: true })?.id).toBe('live')
  })

  it('treats the end as exclusive and ignores other tracks', () => {
    const project = makeProject([makeClip({ id: 'a', timelineStart: 0, sourceOut: 5 })])
    expect(topClipAt(project, 't1', 5)).toBeUndefined()
    expect(topClipAt(project, 't2', 1)).toBeUndefined()
  })
})
