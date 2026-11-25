/**
 * Forward-compatible persistence of effects and new source kinds: round
 * trips, unknown / malformed effects dropped one by one, unknown source
 * kinds dropped with their clips, and v1 files still opening.
 */
import { describe, it, expect } from 'vitest'
import { parse, serialize, IRPROJ_VERSION } from '../../persistence/project'
import { createFade, createShake, createSpotlight, createZoom } from '../types'
import type { Clip, MediaSource, Project } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

function clip(id: string, sourceId: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId: 'v1',
    sourceId,
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 5,
    speed: 1,
    transform: { ...identityTransform },
    volume: 1,
    ...over,
  }
}

function source(id: string, over: Partial<MediaSource> = {}): MediaSource {
  return {
    id,
    kind: 'video',
    opfsPath: id,
    mimeType: 'video/webm',
    duration: 10,
    createdAt: 0,
    name: id,
    ...over,
  }
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'P',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false, height: 72 },
    ],
    clips: [],
    transitions: [],
    sources: [source('s1')],
    duration: 5,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const wrap = (p: unknown, version: number = IRPROJ_VERSION) =>
  JSON.stringify({ format: 'irproj', version, project: p })

describe('effects persistence', () => {
  it('is at format version 2', () => {
    expect(IRPROJ_VERSION).toBe(2)
  })

  it('round-trips every effect type, loop and the new source fields', () => {
    const effects = [
      createZoom(1, 3, { scale: 2.5, focusX: 0.25 }),
      createFade({ in: 0.5, out: 1 }),
      createSpotlight(0, 2, { shape: 'rect' }),
      createShake(2, 4),
      {
        id: 'kb',
        type: 'kenBurns' as const,
        enabled: false,
        fromScale: 1,
        toScale: 1.4,
        fromX: 0.1,
        fromY: 0.2,
        toX: 0.9,
        toY: 0.8,
      },
      {
        id: 'ck',
        type: 'chromaKey' as const,
        enabled: true,
        color: '#00ff00',
        similarity: 0.4,
        smoothness: 0.1,
        spill: 0.2,
      },
    ]
    const p = project({
      clips: [clip('c1', 's1', { effects, loop: true })],
      sources: [
        source('s1', { hasAlpha: true }),
        source('anim', {
          kind: 'animation',
          animation: { format: 'lottie', fps: 30, frameCount: 90, loop: true },
        }),
        source('el', {
          kind: 'element',
          opfsPath: '',
          element: { template: 'subscribe', params: { text: 'Hi', size: 2, on: true } },
        }),
      ],
    })
    const back = parse(serialize(p))
    expect(back.clips[0]?.effects).toEqual(effects)
    expect(back.clips[0]?.loop).toBe(true)
    expect(back.sources.map((s) => s.kind)).toEqual(['video', 'animation', 'element'])
    expect(back.sources[0]?.hasAlpha).toBe(true)
    expect(back.sources[1]?.animation).toEqual(p.sources[1]?.animation)
    expect(back.sources[2]?.element).toEqual(p.sources[2]?.element)
  })

  it('drops unknown and malformed effects individually, keeping the rest', () => {
    const good = createZoom(1, 2)
    const raw = project({
      clips: [
        clip('c1', 's1', {
          effects: [
            { id: 'future', type: 'hologram', enabled: true, power: 9 },
            good,
            { type: 'fade', in: 1, out: 1 }, // no id
            'nonsense',
            null,
            { ...createShake(0, 1), intensity: 'loud' },
            { ...good }, // duplicate id
          ] as unknown as NonNullable<Clip['effects']>,
        }),
      ],
    })
    const back = parse(wrap(raw))
    expect(back.clips).toHaveLength(1)
    expect(back.clips[0]?.effects).toEqual([good])
  })

  it('repairs out-of-range effect values instead of rejecting', () => {
    const raw = project({
      clips: [
        clip('c1', 's1', {
          effects: [
            { ...createZoom(5, 1), scale: 99, focusX: null } as unknown as ReturnType<
              typeof createZoom
            >,
          ],
        }),
      ],
    })
    const z = parse(wrap(raw)).clips[0]?.effects?.[0]
    expect(z).toMatchObject({ start: 5, end: 5.1, scale: 8, focusX: 0.5 })
  })

  it('treats a non-array effects field as no effects', () => {
    const raw = project({
      clips: [
        clip('c1', 's1', {
          effects: 'oops' as unknown as NonNullable<Clip['effects']>,
        }),
      ],
    })
    expect(parse(wrap(raw)).clips[0]?.effects).toBeUndefined()
  })

  it('drops sources of an unknown kind with their clips and transitions', () => {
    const raw = project({
      sources: [
        source('s1'),
        source('hx', { kind: 'hologram' as MediaSource['kind'] }),
      ],
      clips: [clip('keep', 's1'), clip('gone', 'hx', { timelineStart: 5 })],
      transitions: [
        {
          id: 't1',
          fromClipId: 'keep',
          toClipId: 'gone',
          kind: 'crossfade',
          duration: 1,
        },
      ],
    })
    const back = parse(wrap(raw))
    expect(back.sources.map((s) => s.id)).toEqual(['s1'])
    expect(back.clips.map((c) => c.id)).toEqual(['keep'])
    expect(back.transitions).toEqual([])
  })

  it('still rejects a structurally broken known source', () => {
    const raw = project({ sources: [{ kind: 'video' } as unknown as MediaSource] })
    expect(() => parse(wrap(raw))).toThrow()
  })

  it('opens a v1 file (no effects, old kinds) unchanged', () => {
    const v1 = project({ clips: [clip('c1', 's1')] })
    const back = parse(wrap(v1, 1))
    expect(back.clips[0]).toEqual(v1.clips[0])
    expect(back.clips[0]?.effects).toBeUndefined()
  })

  it('refuses a file from a newer format version', () => {
    expect(() => parse(wrap(project(), IRPROJ_VERSION + 1))).toThrow(/Unsupported/)
  })
})
