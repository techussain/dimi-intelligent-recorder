/** Phase 2: crop / anchor persistence, copying on split / cut / duplicate, store tools. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../store'
import { parse, serialize } from '../../persistence/project'
import { duplicateClipData } from '../duplicate'
import { cutTimeRanges } from '../cutRanges'
import {
  fitSelection,
  flipSelection,
  resetSelection,
  setClipAnchor,
  setClipCrop,
  setClipSize,
} from '../../layout/actions'
import type { Clip, MediaSource } from '../types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

const st = () => useEditor.getState()
const identity = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }

const img: MediaSource = {
  id: 'img',
  kind: 'image',
  opfsPath: 'imports/a.png',
  mimeType: 'image/png',
  duration: 0,
  width: 1920,
  height: 1080,
  createdAt: 0,
  name: 'a.png',
}

function addImageClip(over: Partial<Omit<Clip, 'id'>> = {}): string {
  const trackId = st().project.tracks.find((t) => t.kind === 'video')!.id
  return st().addClip({
    trackId,
    sourceId: 'img',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 4,
    speed: 1,
    volume: 1,
    transform: { ...identity },
    ...over,
  })
}
const clip = (id: string) => st().project.clips.find((c) => c.id === id)!

beforeEach(() => {
  st().newProject()
  st().addSource(img)
})

describe('persistence', () => {
  it('round-trips anchor, aspect lock and crop', () => {
    const id = addImageClip({
      transform: { ...identity, anchorX: 0.25, anchorY: 1, lockAspect: false },
      crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0 },
    })
    const back = parse(serialize(st().project)).clips.find((c) => c.id === id)!
    expect(back.transform.anchorX).toBe(0.25)
    expect(back.transform.anchorY).toBe(1)
    expect(back.transform.lockAspect).toBe(false)
    expect(back.crop).toEqual({ left: 0.1, top: 0.2, right: 0.3, bottom: 0 })
  })

  it('repairs out-of-range values and drops a broken crop', () => {
    const id = addImageClip()
    const raw = JSON.parse(serialize(st().project)) as {
      project?: { clips: Record<string, unknown>[] }
      clips?: Record<string, unknown>[]
    }
    const clips = (raw.project ?? raw).clips!
    const c = clips.find((x) => x.id === id)!
    c.transform = { ...identity, anchorX: 7, anchorY: null }
    c.crop = { left: 0.9, right: 0.9, top: 0, bottom: 0 }
    const back = parse(JSON.stringify(raw)).clips.find((x) => x.id === id)!
    expect(back.transform.anchorX).toBe(1)
    expect(back.transform.anchorY).toBeUndefined()
    expect(back.crop!.left + back.crop!.right).toBeCloseTo(0.95)
    c.crop = 'nope'
    expect(
      parse(JSON.stringify(raw)).clips.find((x) => x.id === id)!.crop,
    ).toBeUndefined()
  })

  it('an old project (no new fields) loads unchanged', () => {
    const id = addImageClip({ transform: { ...identity, x: 12, scaleX: -1 } })
    const back = parse(serialize(st().project)).clips.find((c) => c.id === id)!
    expect(back.transform).toEqual({ ...identity, x: 12, scaleX: -1 })
    expect(back.crop).toBeUndefined()
    expect(Object.keys(back).includes('crop') && back.crop !== undefined).toBe(false)
  })
})

describe('copying crop', () => {
  const crop = { left: 0.1, top: 0, right: 0, bottom: 0.2 }

  it('split gives both halves their own copy', () => {
    const id = addImageClip({ crop })
    st().splitAt(2)
    const halves = st().project.clips.filter((c) => c.sourceId === 'img')
    expect(halves).toHaveLength(2)
    expect(halves[0]!.id).toBe(id)
    for (const h of halves) expect(h.crop).toEqual(crop)
    expect(halves[0]!.crop).not.toBe(halves[1]!.crop)
  })

  it('duplicate and ripple cut copy it', () => {
    const id = addImageClip({ crop })
    expect(duplicateClipData(clip(id), 10).crop).toEqual(crop)
    const out = cutTimeRanges(st().project, [{ start: 1, end: 2 }], () => 'new')
    const pieces = out.clips.filter((c) => c.sourceId === 'img')
    expect(pieces).toHaveLength(2)
    for (const p of pieces) expect(p.crop).toEqual(crop)
  })
})

describe('store transform tools (one undo step each)', () => {
  it('setTransforms sets / removes crop and anchor fields', () => {
    const id = addImageClip()
    const past = st().past.length
    st().setTransforms([
      {
        id,
        patch: { x: 5, anchorX: 0 },
        crop: { left: 0.2, top: 0, right: 0, bottom: 0 },
      },
    ])
    expect(st().past.length).toBe(past + 1)
    expect(clip(id).crop?.left).toBe(0.2)
    expect(clip(id).transform.anchorX).toBe(0)
    st().setTransforms([{ id, patch: { anchorX: undefined }, crop: null }])
    expect(clip(id).crop).toBeUndefined()
    expect('anchorX' in clip(id).transform).toBe(false)
    st().undo()
    expect(clip(id).crop?.left).toBe(0.2)
  })

  it('flip toggles the sign (keyframes too) in one step; undo restores', () => {
    const id = addImageClip({
      keyframes: {
        scaleX: [
          { t: 0, value: 1 },
          { t: 2, value: 2 },
        ],
      },
    })
    st().setSelection([id])
    const past = st().past.length
    flipSelection('h')
    expect(st().past.length).toBe(past + 1)
    expect(clip(id).transform.scaleX).toBe(-1)
    expect(clip(id).keyframes?.scaleX?.map((k) => k.value)).toEqual([-1, -2])
    st().undo()
    expect(clip(id).transform.scaleX).toBe(1)
  })

  it('crop keeps the remaining content in place; anchor keeps the object', () => {
    const id = addImageClip({ transform: { ...identity, scaleX: 0.5, scaleY: 0.5 } })
    setClipCrop(id, { left: 0.5 })
    // Scale 0.5 about the (new, kept-box) centre: x shifts so content stays.
    expect(clip(id).crop?.left).toBe(0.5)
    expect(clip(id).transform.x).toBeCloseTo(-240)
    setClipCrop(id, null)
    expect(clip(id).crop).toBeUndefined()
    expect(clip(id).transform.x).toBeCloseTo(0)
    setClipAnchor(id, 0, 0)
    expect(clip(id).transform.anchorX).toBe(0)
    expect(clip(id).transform.x).toBeCloseTo(480)
    expect(clip(id).transform.y).toBeCloseTo(270)
  })

  it('fit / size / reset', () => {
    const id = addImageClip({
      transform: {
        ...identity,
        x: 100,
        scaleX: 0.3,
        scaleY: 0.3,
        rotation: 10,
        opacity: 0.5,
      },
      crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
    })
    st().setSelection([id])
    setClipSize(id, { width: 864 })
    expect(clip(id).transform.scaleX).toBeCloseTo(0.5)
    expect(clip(id).transform.scaleY).toBeCloseTo(0.5)
    fitSelection('fill')
    expect(Math.abs(clip(id).transform.scaleX)).toBeGreaterThan(1)
    resetSelection()
    const t = clip(id).transform
    expect(t).toMatchObject({
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      opacity: 0.5,
    })
    expect(clip(id).crop).toBeUndefined()
  })
})
