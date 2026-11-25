/** Elements-pack store actions, animation looping bounds, project round trip. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../store'
import { parse, serialize } from '../../persistence/project'
import { duplicateClipData } from '../duplicate'
import type { Clip, MediaSource } from '../types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

const st = () => useEditor.getState()
const identity = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }

function animation(over: Partial<MediaSource> = {}): MediaSource {
  return {
    id: 'anim',
    kind: 'animation',
    opfsPath: 'imports/anim.json',
    mimeType: 'application/json',
    duration: 2,
    width: 400,
    height: 400,
    createdAt: 0,
    name: 'anim.json',
    animation: { format: 'lottie', fps: 30, frameCount: 60, loop: true },
    ...over,
  }
}

function animClip(
  trackId: string,
  over: Partial<Omit<Clip, 'id'>> = {},
): Omit<Clip, 'id'> {
  return {
    trackId,
    sourceId: 'anim',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 2,
    speed: 1,
    volume: 0,
    transform: { ...identity },
    ...over,
  }
}

const clipById = (id: string) => st().project.clips.find((c) => c.id === id)!
const sourceById = (id: string) => st().project.sources.find((s) => s.id === id)!

describe('addElementClip', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('adds one element source + a clip on an overlay track in one undo step', () => {
    const pastBefore = st().past.length
    const id = st().addElementClip('subscribe', 3)!
    expect(id).toBeTruthy()
    expect(st().past.length).toBe(pastBefore + 1)
    const c = clipById(id)
    const s = sourceById(c.sourceId)
    expect(s.kind).toBe('element')
    expect(s.element?.template).toBe('subscribe')
    expect(s.opfsPath).toBe('')
    expect(s.width).toBeGreaterThan(0)
    expect(c.timelineStart).toBe(3)
    expect(c.sourceOut).toBe(s.duration)
    const track = st().project.tracks.find((t) => t.id === c.trackId)
    expect(track?.kind).toBe('overlay')
    // The topmost overlay track (first in the list) is used when it has room.
    expect(c.trackId).toBe(st().project.tracks.find((t) => t.kind === 'overlay')!.id)
    st().undo()
    expect(st().project.clips.find((x) => x.id === id)).toBeUndefined()
    expect(st().project.sources.find((x) => x.id === s.id)).toBeUndefined()
  })

  it('creates an overlay track on top when none has room', () => {
    for (const t of st().project.tracks.filter((t) => t.kind === 'overlay'))
      st().removeTrack(t.id)
    const first = st().addElementClip('like', 0)!
    const second = st().addElementClip('like', 0)!
    expect(clipById(second).trackId).not.toBe(clipById(first).trackId)
    expect(st().project.tracks[0]?.id).toBe(clipById(second).trackId)
  })

  it('refuses unknown templates', () => {
    expect(st().addElementClip('nope', 0)).toBeNull()
  })

  it('updateElementParams is undoable and coalesces typing', () => {
    const id = st().addElementClip('lowerThird', 0)!
    const sid = clipById(id).sourceId
    const before = st().past.length
    st().updateElementParams(sid, { name: 'A' })
    st().updateElementParams(sid, { name: 'Ab' })
    st().updateElementParams(sid, { name: 'Abc' })
    expect(st().past.length).toBe(before + 1)
    expect(sourceById(sid).element!.params.name).toBe('Abc')
    st().undo()
    expect(sourceById(sid).element!.params.name).not.toBe('Abc')
  })
})

describe('duplicateClip', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('clones the element source so edits do not leak', () => {
    const id = st().addElementClip('lowerThird', 0)!
    const orig = clipById(id)
    const copy = clipById(st().duplicateClip(id, 10)!)
    expect(copy.sourceId).not.toBe(orig.sourceId)
    st().updateElementParams(copy.sourceId, { name: 'Changed' })
    expect(sourceById(copy.sourceId).element!.params.name).toBe('Changed')
    expect(sourceById(orig.sourceId).element!.params.name).not.toBe('Changed')
  })

  it('shares media sources for other clips and keeps loop', () => {
    st().addSource(animation())
    const id = st().addClip(animClip(st().addTrack('overlay'), { loop: true }))
    const copy = clipById(st().duplicateClip(id, 3)!)
    expect(copy.sourceId).toBe('anim')
    expect(copy.loop).toBe(true)
    expect(duplicateClipData(copy, 0).loop).toBe(true)
  })
})

describe('animation clip length bounds', () => {
  beforeEach(() => {
    st().newProject()
    st().addSource(animation())
  })

  it('caps trimming at the asset duration unless the clip loops', () => {
    const id = st().addClip(animClip(st().addTrack('overlay')))
    st().trimClip(id, 'end', 5)
    expect(clipById(id).sourceOut).toBe(2)
    st().updateClip(id, { sourceOut: 9 })
    expect(clipById(id).sourceOut).toBe(2)
  })

  it('lets a looping clip run past the asset duration', () => {
    const id = st().addClip(animClip(st().addTrack('overlay'), { loop: true }))
    st().trimClip(id, 'end', 5)
    expect(clipById(id).sourceOut).toBe(7)
    st().updateClip(id, { sourceOut: 12 })
    expect(clipById(id).sourceOut).toBe(12)
  })
})

describe('project file round trip', () => {
  it('keeps animation / element sources, loop and hasAlpha', () => {
    st().newProject()
    st().addSource(
      animation({ animation: { format: 'avif', frameCount: 5, loop: false } }),
    )
    st().addSource({ ...animation({ id: 'v' }), kind: 'video', hasAlpha: true })
    st().addClip(animClip(st().addTrack('overlay'), { loop: true }))
    st().addElementClip('subscribe', 5)
    const original = st().project
    const back = parse(serialize(original))
    const s = (id: string) => back.sources.find((x) => x.id === id)!
    expect(s('anim').animation).toEqual({ format: 'avif', frameCount: 5, loop: false })
    expect(s('v').hasAlpha).toBe(true)
    expect(back.clips.find((c) => c.sourceId === 'anim')!.loop).toBe(true)
    const el = back.sources.find((x) => x.kind === 'element')!
    expect(el.element?.template).toBe('subscribe')
    expect(el.element?.params).toEqual(
      original.sources.find((x) => x.kind === 'element')!.element!.params,
    )
  })
})
