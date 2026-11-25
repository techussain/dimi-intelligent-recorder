/** drawScene's element branch, chroma-key layer selection and element placement. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../elements', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../elements')>()
  return { ...orig, drawElement: vi.fn(() => true) }
})

import { drawElement } from '../../elements'
import { buildScene, drawScene, elementBaseBox, fitView } from '../scene'
import { layerChroma, chromaProcessImage } from '../chromaLayer'
import { createChromaKey } from '../../effects/types'
import { createMockContext } from '../../elements/__tests__/mockContext'
import type { Clip, MediaSource, Project, Track } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

const track = (id: string, kind: Track['kind']): Track => ({
  id,
  kind,
  name: id,
  muted: false,
  locked: false,
  height: 40,
})

function elementSource(): MediaSource {
  return {
    id: 'el',
    kind: 'element',
    opfsPath: '',
    mimeType: 'application/x-element',
    duration: 4,
    width: 640,
    height: 200,
    createdAt: 0,
    name: 'Lower third',
    element: { template: 'lowerThird', params: { name: 'Ada', n: 3, flag: true } },
  }
}

function project(sources: MediaSource[], clips: Clip[]): Project {
  return {
    id: 'p',
    name: 'p',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [track('ov', 'overlay')],
    clips,
    transitions: [],
    sources,
    duration: 10,
    createdAt: 0,
    updatedAt: 0,
  }
}

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c',
  trackId: 'ov',
  sourceId: 'el',
  timelineStart: 1,
  sourceIn: 0,
  sourceOut: 4,
  speed: 1,
  transform: { ...identityTransform },
  volume: 0,
  ...over,
})

const view = fitView(1920, 1080, 1920, 1080)

describe('drawScene element branch', () => {
  beforeEach(() => vi.mocked(drawElement).mockClear())

  it('draws the element vectorially with its params, local time and clip duration', () => {
    const p = project([elementSource()], [clip()])
    const { ctx } = createMockContext()
    const scene = buildScene(p, 2.5, { includeLive: false })
    const getImage = vi.fn(() => null)
    drawScene(ctx, p, 2.5, scene, getImage, view)
    expect(getImage).not.toHaveBeenCalled()
    expect(drawElement).toHaveBeenCalledTimes(1)
    const [, id, params, t, dur, box] = vi.mocked(drawElement).mock.calls[0]!
    expect(id).toBe('lowerThird')
    // booleans are dropped from the params
    expect(params).toEqual({ name: 'Ada', n: 3 })
    expect(t).toBeCloseTo(1.5)
    expect(dur).toBe(4)
    expect(box.w).toBeGreaterThan(0)
    expect(box.h).toBeGreaterThan(0)
  })

  it('does not draw outside the clip', () => {
    const p = project([elementSource()], [clip()])
    const { ctx } = createMockContext()
    drawScene(ctx, p, 9, buildScene(p, 9, { includeLive: false }), () => null, view)
    expect(drawElement).not.toHaveBeenCalled()
  })

  it('skips element sources without element info', () => {
    const bad = elementSource()
    delete bad.element
    const p = project([bad], [clip()])
    expect(buildScene(p, 2, { includeLive: false })).toHaveLength(0)
  })

  it('leaves the background transparent with the transparent option', () => {
    const p = project([elementSource()], [clip()])
    const { ctx, calls } = createMockContext()
    drawScene(ctx, p, 2, buildScene(p, 2, { includeLive: false }), () => null, view, {
      transparent: true,
    })
    expect(calls.some(([n]) => n === 'clearRect')).toBe(true)
    expect(calls.some(([n]) => n === 'fillRect')).toBe(false)
  })
})

describe('elementBaseBox', () => {
  it('scales the 1080p template size to the project and caps at 90 % of the frame', () => {
    const big = elementBaseBox(1920, 1080, elementSource())
    expect(big.w).toBeGreaterThan(0)
    const half = elementBaseBox(960, 540, elementSource())
    expect(half.w).toBeCloseTo(big.w / 2)
    const narrow = elementBaseBox(400, 1080, elementSource())
    expect(narrow.w).toBeLessThanOrEqual(400 * 0.9 + 1e-6)
  })
})

describe('chroma key layer selection', () => {
  const fx = createChromaKey({ color: '#00ff00' })
  it('applies to video and animation clips with an enabled chromaKey', () => {
    expect(
      layerChroma({ clip: { effects: [fx] }, source: { kind: 'video' } }),
    ).toMatchObject({ color: '#00ff00' })
    expect(
      layerChroma({ clip: { effects: [fx] }, source: { kind: 'animation' } }),
    ).not.toBeNull()
  })
  it('ignores disabled effects, other kinds and clips without effects', () => {
    expect(
      layerChroma({
        clip: { effects: [{ ...fx, enabled: false }] },
        source: { kind: 'video' },
      }),
    ).toBeNull()
    expect(
      layerChroma({ clip: { effects: [fx] }, source: { kind: 'image' } }),
    ).toBeNull()
    expect(
      layerChroma({ clip: { effects: [fx] }, source: { kind: 'element' } }),
    ).toBeNull()
    expect(layerChroma({ clip: {}, source: { kind: 'video' } })).toBeNull()
  })
  it('creates the processor lazily, only for keyed layers', () => {
    const getProcessor = vi.fn(() => null)
    const hook = chromaProcessImage(getProcessor)
    const el = document.createElement('canvas')
    el.width = 4
    el.height = 4
    const source = { ...elementSource(), kind: 'video' as const }
    const layer = (c: Clip) =>
      ({ clip: c, source }) as unknown as Parameters<typeof hook>[0]
    expect(hook(layer(clip()), el)).toBe(el)
    expect(getProcessor).not.toHaveBeenCalled()
    // No processor available -> the image is drawn unchanged.
    expect(hook(layer(clip({ effects: [fx] })), el)).toBe(el)
    expect(getProcessor).toHaveBeenCalledTimes(1)
  })
})
