import { describe, it, expect, vi } from 'vitest'
import {
  axisAlignedBounds,
  collectActiveVisuals,
  computeResizePatch,
  pointInBox,
  unionBounds,
  visualBox,
  type TextMeasurer,
} from '../geometry'
import { baseBox, elementBaseBox } from '../../compositor/scene'
import type { Clip, MediaSource, Project, Track, Transform } from '../../timeline/types'
import { defaultTextStyle, identityTransform } from '../../timeline/types'

const project = { width: 1920, height: 1080 }

const tf = (patch: Partial<Transform> = {}): Transform => ({
  ...identityTransform,
  ...patch,
})

function source(
  kind: MediaSource['kind'],
  extra: Partial<MediaSource> = {},
): MediaSource {
  return {
    id: kind,
    kind,
    opfsPath: '',
    mimeType: '',
    duration: 5,
    createdAt: 0,
    name: kind,
    ...extra,
  }
}

const video: Pick<Track, 'kind'> = { kind: 'video' }
const overlay: Pick<Track, 'kind'> = { kind: 'overlay' }

describe('visualBox', () => {
  it('main-track media: contain-fit, centred, plus the transform', () => {
    const src = source('video', { width: 1280, height: 720 })
    const box = visualBox(project, video, src, tf({ x: 10, y: -20, scaleX: 0.5 }))
    expect(box).not.toBeNull()
    expect(box?.width).toBeCloseTo(960)
    expect(box?.height).toBeCloseTo(1080)
    expect(box?.centerX).toBeCloseTo(970)
    expect(box?.centerY).toBeCloseTo(520)
    expect(box?.left).toBeCloseTo(970 - 480)
    expect(box?.baseWidth).toBeCloseTo(1920)
  })

  it('overlay-track media: the PIP base box from the compositor', () => {
    const src = source('image', { width: 400, height: 300 })
    const base = baseBox(1920, 1080, true, 400, 300)
    const box = visualBox(project, overlay, src, tf())
    expect(box?.width).toBeCloseTo(base.w)
    expect(box?.height).toBeCloseTo(base.h)
    expect(box?.centerX).toBeCloseTo(base.cx)
    expect(box?.centerY).toBeCloseTo(base.cy)
  })

  it('element: the template base box', () => {
    const src = source('element', {
      width: 640,
      height: 200,
      element: { template: 'lowerThird', params: {} },
    })
    const base = elementBaseBox(1920, 1080, src)
    const box = visualBox(project, overlay, src, tf({ scaleX: 2 }))
    expect(box?.width).toBeCloseTo(base.w * 2)
    expect(box?.height).toBeCloseTo(base.h)
    expect(box?.centerX).toBeCloseTo(base.cx)
  })

  it('text: measured by the injected measurer, centred on the frame + offset', () => {
    const measure = vi.fn<TextMeasurer>(() => ({ x: 0, y: 0, w: 300, h: 80 }))
    const src = source('text', { text: { ...defaultTextStyle } })
    const box = visualBox(project, overlay, src, tf({ x: 100, scaleY: 1.5 }), measure)
    expect(measure).toHaveBeenCalledWith(src.text, 1920, 1080)
    expect(box?.width).toBeCloseTo(300)
    expect(box?.height).toBeCloseTo(120)
    expect(box?.centerX).toBeCloseTo(1060)
    expect(box?.centerY).toBeCloseTo(540)
    expect(box?.baseWidth).toBe(300)
  })

  it('text without a measurer has no box; audio never has one', () => {
    const text = source('text', { text: { ...defaultTextStyle } })
    expect(visualBox(project, overlay, text, tf())).toBeNull()
    expect(visualBox(project, video, source('audio'), tf())).toBeNull()
  })

  it('negative scale (mirror) gives a positive box and correct hit-testing', () => {
    const src = source('image', { width: 1920, height: 1080 })
    const box = visualBox(project, video, src, tf({ scaleX: -0.5, scaleY: -0.5 }))
    expect(box).not.toBeNull()
    if (!box) return
    expect(box.width).toBeCloseTo(960)
    expect(box.height).toBeCloseTo(540)
    expect(box.left).toBeCloseTo(480)
    expect(box.top).toBeCloseTo(270)
    expect(box.flipX).toBe(true)
    expect(box.flipY).toBe(true)
    expect(pointInBox({ x: 960, y: 540 }, box)).toBe(true)
    expect(pointInBox({ x: 500, y: 300 }, box)).toBe(true)
    expect(pointInBox({ x: 100, y: 100 }, box)).toBe(false)
  })

  it('mirrored text measures positive', () => {
    const measure: TextMeasurer = () => ({ x: 0, y: 0, w: 200, h: 50 })
    const src = source('text', { text: { ...defaultTextStyle } })
    const box = visualBox(project, overlay, src, tf({ scaleX: -1 }), measure)
    expect(box?.width).toBe(200)
    expect(box?.flipX).toBe(true)
  })
})

describe('axisAlignedBounds / hit-testing', () => {
  it('unrotated box = its own rect', () => {
    const b = axisAlignedBounds({
      centerX: 100,
      centerY: 50,
      width: 40,
      height: 20,
      rotation: 0,
    })
    expect(b).toEqual({ left: 80, top: 40, right: 120, bottom: 60 })
  })

  it('rotated 90° swaps the extents; 45° grows them', () => {
    const r90 = axisAlignedBounds({
      centerX: 0,
      centerY: 0,
      width: 40,
      height: 20,
      rotation: 90,
    })
    expect(r90.left).toBeCloseTo(-10)
    expect(r90.right).toBeCloseTo(10)
    expect(r90.top).toBeCloseTo(-20)
    expect(r90.bottom).toBeCloseTo(20)
    const r45 = axisAlignedBounds({
      centerX: 0,
      centerY: 0,
      width: 100,
      height: 100,
      rotation: 45,
    })
    expect(r45.right).toBeCloseTo(50 * Math.SQRT2)
  })

  it('pointInBox respects rotation', () => {
    const box = { centerX: 0, centerY: 0, width: 100, height: 10, rotation: 90 }
    expect(pointInBox({ x: 0, y: 45 }, box)).toBe(true)
    expect(pointInBox({ x: 45, y: 0 }, box)).toBe(false)
  })

  it('unionBounds', () => {
    expect(unionBounds([])).toBeNull()
    expect(
      unionBounds([
        { left: 0, top: 10, right: 5, bottom: 20 },
        { left: -5, top: 12, right: 3, bottom: 30 },
      ]),
    ).toEqual({ left: -5, top: 10, right: 5, bottom: 30 })
  })
})

describe('computeResizePatch', () => {
  const src = source('image', { width: 1920, height: 1080 })

  it('dragging the east handle keeps the west edge fixed', () => {
    const box = visualBox(project, video, src, tf({ scaleX: 0.5, scaleY: 0.5 }))
    if (!box) throw new Error('no box')
    const patch = computeResizePatch(
      box,
      { x: 1640, y: 540 },
      { dirX: 1, dirY: 0, corner: false },
      false,
      false,
    )
    // West edge at 480, new right edge at 1640 → width 1160.
    expect((patch.scaleX ?? 0) * 1920).toBeCloseTo(1160)
    expect(1920 / 2 + (patch.x ?? 0) - 580).toBeCloseTo(480)
  })

  it('keeps a mirrored object mirrored', () => {
    const box = visualBox(project, video, src, tf({ scaleX: -0.5, scaleY: 0.5 }))
    if (!box) throw new Error('no box')
    const patch = computeResizePatch(
      box,
      { x: 1640, y: 540 },
      { dirX: 1, dirY: 0, corner: false },
      false,
      false,
    )
    expect(patch.scaleX).toBeLessThan(0)
    expect(Math.abs(patch.scaleX ?? 0) * 1920).toBeCloseTo(1160)
    expect(patch.scaleY).toBeGreaterThan(0)
  })
})

describe('collectActiveVisuals', () => {
  it('returns visible visual clips topmost first, skipping live and hidden', () => {
    const tracks: Track[] = [
      {
        id: 'o1',
        kind: 'overlay',
        name: 'o1',
        muted: false,
        locked: false,
        height: 40,
      },
      {
        id: 'o2',
        kind: 'overlay',
        name: 'o2',
        muted: false,
        locked: false,
        height: 40,
        hidden: true,
      },
      { id: 'v1', kind: 'video', name: 'v1', muted: false, locked: false, height: 40 },
    ]
    const clip = (id: string, trackId: string, extra: Partial<Clip> = {}): Clip => ({
      id,
      trackId,
      sourceId: 'img',
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 5,
      speed: 1,
      transform: tf(),
      volume: 1,
      ...extra,
    })
    const p: Project = {
      id: 'p',
      name: 'p',
      fps: 30,
      width: 1920,
      height: 1080,
      sampleRate: 48000,
      tracks,
      clips: [clip('a', 'o1'), clip('b', 'o2'), clip('c', 'v1', { isLive: true })],
      transitions: [],
      sources: [source('image', { id: 'img', width: 100, height: 100 })],
      duration: 5,
      createdAt: 0,
      updatedAt: 0,
    }
    const list = collectActiveVisuals(p, 1)
    expect(list.map((o) => o.clip.id)).toEqual(['a'])
  })
})
