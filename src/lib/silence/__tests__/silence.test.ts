import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EnvelopeBuilder,
  autoThreshold,
  detectSilences,
  silencesOnTimeline,
  type Envelope,
} from '../detect'
import {
  cutTimeRanges,
  lockedTracksAffected,
  normalizeRanges,
} from '../../timeline/cutRanges'
import { useEditor } from '../../timeline/store'
import type { Clip, Project } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

/** Envelope from a loudness pattern: one dB value per 20 ms frame. */
function env(pattern: [db: number, sec: number][], start = 0): Envelope {
  const db: number[] = []
  for (const [v, sec] of pattern)
    for (let i = 0; i < Math.round(sec / 0.02); i++) db.push(v)
  return { frameSec: 0.02, start, db: Float32Array.from(db) }
}

const clip = (o: Partial<Clip> & Pick<Clip, 'id' | 'trackId'>): Clip => ({
  sourceId: 's',
  timelineStart: 0,
  sourceIn: 0,
  sourceOut: 10,
  speed: 1,
  volume: 1,
  transform: { ...identityTransform },
  ...o,
})

const project = (clips: Clip[], extra: Partial<Project> = {}): Project => ({
  id: 'p',
  name: 'P',
  fps: 30,
  width: 1920,
  height: 1080,
  sampleRate: 48000,
  tracks: [
    { id: 'v', kind: 'video', name: 'V1', muted: false, locked: false, height: 72 },
    { id: 'a', kind: 'audio', name: 'A1', muted: false, locked: false, height: 48 },
  ],
  clips,
  transitions: [],
  sources: [],
  duration: 0,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
})

const ids = (() => {
  let n = 0
  return () => `new${++n}`
})()

describe('EnvelopeBuilder', () => {
  it('gives ~-3 dBFS for a full-scale sine and very low for silence', () => {
    const rate = 48_000
    const b = new EnvelopeBuilder(rate)
    const sine = Float32Array.from({ length: rate }, (_, i) =>
      Math.sin((2 * Math.PI * 440 * i) / rate),
    )
    b.push([sine], sine.length)
    b.push([new Float32Array(rate)], rate)
    const db = b.finish()
    expect(db.length).toBe(100) // 2 s / 20 ms
    expect(db[10]).toBeCloseTo(-3.01, 0)
    expect(db[90]).toBeLessThan(-100)
  })
})

describe('detectSilences', () => {
  const opts = { thresholdDb: -40, minSilenceSec: 0.5, paddingSec: 0.1 }

  it('finds pauses, pads the speech side, ignores short gaps', () => {
    const e = env([
      [-60, 1], // leading silence: only padded before speech
      [-20, 2],
      [-60, 0.3], // too short
      [-20, 1],
      [-60, 1], // inner pause: padded on both sides
      [-20, 1],
      [-60, 0.8], // trailing: only padded after speech
    ])
    const r = detectSilences(e, opts)
    expect(r).toHaveLength(3)
    expect(r[0]!.start).toBeCloseTo(0)
    expect(r[0]!.end).toBeCloseTo(0.9)
    expect(r[1]!.start).toBeCloseTo(4.4)
    expect(r[1]!.end).toBeCloseTo(5.2)
    expect(r[2]!.start).toBeCloseTo(6.4)
    expect(r[2]!.end).toBeCloseTo(7.1)
  })

  it('reports times in file time (offset by the audio start)', () => {
    const r = detectSilences(
      env(
        [
          [-20, 1],
          [-60, 1],
          [-20, 1],
        ],
        2.5,
      ),
      opts,
    )
    expect(r[0]!.start).toBeCloseTo(3.6)
  })

  it('autoThreshold sits between noise floor and speech', () => {
    const t = autoThreshold(
      env([
        [-55, 3],
        [-18, 7],
      ]).db,
    )
    expect(t).toBeGreaterThan(-55)
    expect(t).toBeLessThan(-18 - 10)
  })
})

describe('silencesOnTimeline', () => {
  it('maps through trim and speed', () => {
    const c = clip({
      id: 'c',
      trackId: 'a',
      timelineStart: 10,
      sourceIn: 2,
      sourceOut: 8,
      speed: 2,
    })
    const r = silencesOnTimeline(c, [
      { start: 0, end: 1 }, // before the in point
      { start: 4, end: 6 },
      { start: 7, end: 9 }, // cut at the out point
    ])
    expect(r).toEqual([
      { start: 11, end: 12 },
      { start: 12.5, end: 13 },
    ])
  })
})

describe('cutTimeRanges', () => {
  it('removes, splits, trims and shifts clips on every track', () => {
    const p = project([
      clip({ id: 'screen', trackId: 'v', timelineStart: 0, sourceOut: 10 }), // spans the cut
      clip({ id: 'inside', trackId: 'a', timelineStart: 3, sourceOut: 1 }), // [3,4] inside
      clip({ id: 'tail', trackId: 'a', timelineStart: 1, sourceOut: 2.5 }), // [1,3.5] tail cut
      clip({ id: 'head', trackId: 'a', timelineStart: 4.5, sourceOut: 2 }), // [4.5,6.5] head cut
      clip({ id: 'after', trackId: 'a', timelineStart: 8, sourceOut: 1 }), // shifts
    ])
    const out = cutTimeRanges(p, [{ start: 3, end: 5 }], ids)
    const by = (id: string) => out.clips.find((c) => c.id === id)
    expect(by('inside')).toBeUndefined()
    expect(by('screen')).toMatchObject({ timelineStart: 0, sourceIn: 0, sourceOut: 3 })
    const right = out.clips.find((c) => c.id.startsWith('new') && c.trackId === 'v')
    expect(right).toMatchObject({ timelineStart: 3, sourceIn: 5, sourceOut: 10 })
    expect(by('tail')).toMatchObject({ timelineStart: 1, sourceOut: 2 })
    expect(by('head')).toMatchObject({ timelineStart: 3, sourceIn: 0.5, sourceOut: 2 })
    expect(by('after')).toMatchObject({ timelineStart: 6 })
    expect(out.duration).toBeCloseTo(8)
  })

  it('handles several ranges and speed', () => {
    const p = project([clip({ id: 'c', trackId: 'a', sourceOut: 20, speed: 2 })]) // 10 s on timeline
    const out = cutTimeRanges(
      p,
      [
        { start: 6, end: 7 },
        { start: 2, end: 3 },
      ],
      ids,
    )
    const pieces = [...out.clips].sort((a, b) => a.timelineStart - b.timelineStart)
    expect(pieces.map((c) => [c.timelineStart, c.sourceIn, c.sourceOut])).toEqual([
      [0, 0, 4],
      [2, 6, 12],
      [5, 14, 20],
    ])
    expect(out.duration).toBeCloseTo(8)
  })

  it('shifts markers and drops those inside a range; drops transitions on cut clips', () => {
    const p = project(
      [
        clip({ id: 'x', trackId: 'v', sourceOut: 4 }),
        clip({ id: 'y', trackId: 'v', timelineStart: 4, sourceOut: 4 }),
        clip({ id: 'z', trackId: 'v', timelineStart: 20, sourceOut: 2 }),
        clip({ id: 'w', trackId: 'v', timelineStart: 22, sourceOut: 2 }),
      ],
      {
        markers: [
          { id: 'm1', time: 5, label: '' },
          { id: 'm2', time: 9, label: '' },
        ],
        transitions: [
          { id: 't1', fromClipId: 'x', toClipId: 'y', kind: 'crossfade', duration: 1 },
          { id: 't2', fromClipId: 'z', toClipId: 'w', kind: 'crossfade', duration: 1 },
        ],
      },
    )
    const out = cutTimeRanges(p, [{ start: 4.5, end: 6 }], ids)
    expect(out.markers?.map((m) => [m.id, m.time])).toEqual([['m2', 7.5]])
    expect(out.transitions.map((t) => t.id)).toEqual(['t2'])
  })

  it('merges overlapping ranges and reports locked tracks that would change', () => {
    expect(
      normalizeRanges([
        { start: 5, end: 6 },
        { start: 1, end: 3 },
        { start: 2.5, end: 4 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ])
    const p = project([clip({ id: 'c', trackId: 'a', timelineStart: 10 })])
    p.tracks[1] = { ...p.tracks[1]!, locked: true }
    expect(lockedTracksAffected(p, [{ start: 2, end: 3 }])).toEqual(['A1'])
    expect(lockedTracksAffected(p, [{ start: 30, end: 31 }])).toEqual([])
  })
})

describe('store.removeTimeRanges', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('cuts in one undo step and undo restores the timeline', () => {
    const st = useEditor.getState()
    const track = st.project.tracks[0]!.id
    st.addClip({
      trackId: track,
      sourceId: 's',
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 10,
      speed: 1,
      volume: 1,
      transform: { ...identityTransform },
    })
    const before = JSON.stringify(useEditor.getState().project.clips)
    const past = useEditor.getState().past.length
    const r = useEditor.getState().removeTimeRanges([{ start: 2, end: 4 }])
    expect(r).toMatchObject({ ok: true, removedSec: 2, count: 1 })
    expect(useEditor.getState().project.duration).toBeCloseTo(8)
    expect(useEditor.getState().past.length).toBe(past + 1)
    useEditor.getState().undo()
    expect(JSON.stringify(useEditor.getState().project.clips)).toBe(before)
  })

  it('refuses while recording', () => {
    useEditor.getState().startRecording()
    expect(useEditor.getState().removeTimeRanges([{ start: 0, end: 1 }]).ok).toBe(false)
    useEditor.getState().stopRecording()
  })
})
