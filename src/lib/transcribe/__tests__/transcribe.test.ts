import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MonoResampler } from '../pcm'
import { appendBlock, cleanSegments } from '../segments'
import {
  buildCaptionCues,
  cuesFromCaptionTrack,
  splitCue,
  toSrt,
  captionStyle,
} from '../captions'
import { useEditor } from '../../timeline/store'
import type { Clip, Project, Transcript } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'P',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, locked: false, height: 48 },
    ],
    clips: [],
    transitions: [],
    sources: [
      {
        id: 's1',
        kind: 'audio',
        opfsPath: 'x.webm',
        mimeType: 'audio/webm',
        duration: 60,
        createdAt: 0,
        name: 'mic',
      },
    ],
    duration: 60,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function clip(overrides: Partial<Clip>): Clip {
  return {
    id: 'c1',
    trackId: 'a1',
    sourceId: 's1',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 60,
    speed: 1,
    volume: 1,
    transform: { ...identityTransform },
    ...overrides,
  }
}

const transcript = (segments: Transcript['segments']): Transcript => ({
  model: 'm',
  language: 'en',
  createdAt: 0,
  segments,
})

describe('MonoResampler', () => {
  it('downmixes stereo and downsamples 48k → 16k by averaging', () => {
    const r = new MonoResampler(48_000)
    const left = new Float32Array(48_000).fill(1)
    const right = new Float32Array(48_000).fill(0)
    r.push([left, right], 48_000)
    const out = r.finish()
    expect(out.length).toBe(16_000)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[15_999]).toBeCloseTo(0.5)
  })

  it('is independent of chunk boundaries', () => {
    const a = new MonoResampler(44_100)
    const b = new MonoResampler(44_100)
    const data = Float32Array.from({ length: 44_100 }, (_, i) => Math.sin(i / 10))
    a.push([data], data.length)
    for (let i = 0; i < data.length; i += 1000) {
      const chunk = data.subarray(i, Math.min(data.length, i + 1000))
      b.push([chunk], chunk.length)
    }
    const oa = a.finish()
    const ob = b.finish()
    expect(ob.length).toBe(oa.length)
    expect(Math.max(...oa.map((v, i) => Math.abs(v - ob[i]!)))).toBeLessThan(1e-6)
  })
})

describe('MonoResampler at any input rate', () => {
  /** One second of a 440 Hz tone at `rate`, resampled to 16 kHz in chunks. */
  function resampleTone(rate: number): Float32Array {
    const r = new MonoResampler(rate)
    const chunk = 1000
    for (let off = 0; off < rate; off += chunk) {
      const n = Math.min(chunk, rate - off)
      const data = new Float32Array(n)
      for (let i = 0; i < n; i++)
        data[i] = Math.sin((2 * Math.PI * 440 * (off + i)) / rate)
      r.push([data], n)
    }
    return r.finish()
  }
  const zeroCrossings = (x: Float32Array) => {
    let n = 0
    for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++
    return n
  }

  // 8 kHz and 11.025 kHz (phone / voice-memo audio) need upsampling.
  for (const rate of [8_000, 11_025, 16_000, 22_050, 48_000]) {
    it(`${rate} Hz → 16 kHz: right length, no NaN, same pitch`, () => {
      const out = resampleTone(rate)
      expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(2)
      expect(out.every((v) => Number.isFinite(v))).toBe(true)
      // 440 Hz → ~880 zero crossings per second.
      expect(Math.abs(zeroCrossings(out) - 880)).toBeLessThanOrEqual(4)
      expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(0.8)
    })
  }
})

describe('segments', () => {
  it('drops empty and non-speech annotations and sorts', () => {
    const out = cleanSegments([
      { start: 5, end: 6, text: '  second  ' },
      { start: 0, end: 1, text: '[BLANK_AUDIO]' },
      { start: 1, end: 2, text: '(upbeat music)' },
      { start: 2, end: 3, text: 'first' },
      { start: 4, end: 4, text: 'zero length' },
    ])
    expect(out.map((s) => s.text)).toEqual(['first', 'second'])
  })

  it('drops the duplicated overlap when appending a block', () => {
    const merged = appendBlock(
      [{ start: 280, end: 295, text: 'end of block one' }],
      [
        { start: 290, end: 294, text: 'end of block one' }, // overlap duplicate
        { start: 295, end: 300, text: 'block two' },
      ],
    )
    expect(merged.map((s) => s.text)).toEqual(['end of block one', 'block two'])
  })
})

describe('buildCaptionCues', () => {
  it('maps segments through trim and speed onto the timeline', () => {
    const p = project({
      clips: [clip({ timelineStart: 10, sourceIn: 20, sourceOut: 40, speed: 2 })],
      transcripts: {
        s1: transcript([
          { start: 5, end: 8, text: 'trimmed away' },
          { start: 22, end: 26, text: 'kept' },
          { start: 38, end: 44, text: 'cut at the out point' },
        ]),
      },
    })
    const cues = buildCaptionCues(p)
    expect(cues).toEqual([
      { start: 11, end: 13, text: 'kept' },
      { start: 19, end: 20, text: 'cut at the out point' },
    ])
  })

  it('ignores muted tracks and live clips', () => {
    const p = project({
      tracks: [
        { id: 'a1', kind: 'audio', name: 'A1', muted: true, locked: false, height: 48 },
      ],
      clips: [clip({})],
      transcripts: { s1: transcript([{ start: 1, end: 2, text: 'hi' }]) },
    })
    expect(buildCaptionCues(p)).toEqual([])
    const live = project({
      clips: [clip({ isLive: true })],
      transcripts: { s1: transcript([{ start: 1, end: 2, text: 'hi' }]) },
    })
    expect(buildCaptionCues(live)).toEqual([])
  })

  it('never lets cues overlap', () => {
    const p = project({
      clips: [clip({})],
      transcripts: {
        s1: transcript([
          { start: 0, end: 5, text: 'one' },
          { start: 3, end: 6, text: 'two' },
        ]),
      },
    })
    const [a, b] = buildCaptionCues(p)
    expect(a!.end).toBeLessThanOrEqual(b!.start)
  })
})

describe('splitCue / toSrt', () => {
  it('wraps to two lines and splits longer text into timed pages', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const pages = splitCue({ start: 0, end: 10, text })
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages) {
      const lines = p.text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(2)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42)
    }
    expect(pages[0]!.start).toBe(0)
    expect(pages[pages.length - 1]!.end).toBe(10)
  })

  it('formats SubRip times', () => {
    expect(toSrt([{ start: 3661.5, end: 3662.25, text: 'Hello\nworld' }])).toBe(
      '1\n01:01:01,500 --> 01:01:02,250\nHello\nworld\n',
    )
  })
})

describe('store: transcripts and captions', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('keeps a transcript across undo/redo', () => {
    const st = useEditor.getState()
    st.addTrack('audio', 'extra')
    st.setTranscript('s1', transcript([{ start: 0, end: 1, text: 'hi' }]))
    useEditor.getState().undo()
    expect(useEditor.getState().project.transcripts?.['s1']?.segments).toHaveLength(1)
    useEditor.getState().redo()
    expect(useEditor.getState().project.transcripts?.['s1']?.segments).toHaveLength(1)
  })

  it('setCaptions creates a top Captions track in one undo step and replaces on rerun', () => {
    const style = captionStyle(useEditor.getState().project)
    const pastBefore = useEditor.getState().past.length
    const n = useEditor.getState().setCaptions(
      [
        { start: 0, end: 1, text: 'a' },
        { start: 1, end: 2, text: 'b' },
      ],
      style,
    )
    expect(n).toBe(2)
    let p = useEditor.getState().project
    expect(p.tracks[0]?.role).toBe('captions')
    expect(useEditor.getState().past.length).toBe(pastBefore + 1)
    expect(cuesFromCaptionTrack(p).map((c) => c.text)).toEqual(['a', 'b'])

    useEditor.getState().setCaptions([{ start: 0, end: 3, text: 'c' }], style)
    p = useEditor.getState().project
    expect(p.tracks.filter((t) => t.role === 'captions')).toHaveLength(1)
    expect(cuesFromCaptionTrack(p).map((c) => c.text)).toEqual(['c'])
    // Old caption sources are removed, not left in the project.
    expect(p.sources.filter((s) => s.captionFor)).toHaveLength(1)

    useEditor.getState().undo()
    expect(
      cuesFromCaptionTrack(useEditor.getState().project).map((c) => c.text),
    ).toEqual(['a', 'b'])
  })
})
