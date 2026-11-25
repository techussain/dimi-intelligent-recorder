/**
 * Track locks are enforced centrally in the store's edit(): no action —
 * drag, keyboard, menu or inspector — may change a clip on a locked track.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../store'
import type { Clip } from '../types'
import { identityTransform } from '../types'

vi.mock('../../storage/blobCache', () => ({
  releaseAll: vi.fn(),
}))

function makeClip(overrides: Partial<Omit<Clip, 'id'>>): Omit<Clip, 'id'> {
  return {
    trackId: '',
    sourceId: 'src1',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 10,
    speed: 1,
    transform: { ...identityTransform },
    volume: 1,
    ...overrides,
  }
}

const st = () => useEditor.getState()
const clip = (id: string) => st().project.clips.find((c) => c.id === id)

/** Two video tracks with one clip each; the first track is then locked. */
function setup() {
  const locked = st().addTrack('video', 'Locked')
  const open = st().addTrack('video', 'Open')
  const a = st().addClip(makeClip({ trackId: locked }))
  const b = st().addClip(makeClip({ trackId: open }))
  st().updateTrack(locked, { locked: true })
  return { locked, open, a, b }
}

describe('track locks', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('removeClips deletes only the unlocked clips of a mixed selection', () => {
    const { a, b } = setup()
    st().removeClips([a, b])
    expect(clip(a)).toBeDefined()
    expect(clip(b)).toBeUndefined()
  })

  it('rippleDeleteClips skips locked clips', () => {
    const { a } = setup()
    st().rippleDeleteClips([a])
    expect(clip(a)).toBeDefined()
  })

  it('splitAt leaves locked tracks unsplit', () => {
    const { locked, open } = setup()
    st().splitAt(5)
    const on = (t: string) => st().project.clips.filter((c) => c.trackId === t).length
    expect(on(locked)).toBe(1)
    expect(on(open)).toBe(2)
  })

  it('refuses trims, moves and transforms of a locked clip without an undo step', () => {
    const { a } = setup()
    const before = st().project
    const pastLen = st().past.length
    st().trimClip(a, 'start', 1)
    st().moveClip(a, 2)
    st().setTransform(a, { x: 100 })
    st().updateClip(a, { volume: 0.2 })
    expect(st().project).toBe(before)
    expect(st().past.length).toBe(pastLen)
  })

  it('refuses moving a linked group when one member is locked', () => {
    const { a, b } = setup()
    st().updateTrack(st().project.clips.find((c) => c.id === a)!.trackId, {
      locked: false,
    })
    st().linkClips([a, b])
    st().updateTrack(clip(a)!.trackId, { locked: true })
    const startB = clip(b)!.timelineStart
    st().moveClip(b, 3)
    expect(clip(b)!.timelineStart).toBe(startB)
  })

  it('refuses adding a clip onto a locked track', () => {
    const { locked } = setup()
    const n = st().project.clips.length
    st().addClip(makeClip({ trackId: locked, timelineStart: 20 }))
    expect(st().project.clips.length).toBe(n)
  })

  it('duplicateClip returns null when the copy would land on a locked track', () => {
    const { a } = setup()
    expect(st().duplicateClip(a, 20)).toBeNull()
  })

  it('addTextClip avoids a locked overlay track', () => {
    const overlay = st().addTrack('overlay', 'Locked overlay')
    st().updateTrack(overlay, { locked: true })
    const id = st().addTextClip(overlay, 0)
    expect(clip(id)).toBeDefined()
    expect(clip(id)!.trackId).not.toBe(overlay)
  })

  it('unlocking makes the clip editable again', () => {
    const { locked, a } = setup()
    st().updateTrack(locked, { locked: false })
    st().removeClips([a])
    expect(clip(a)).toBeUndefined()
  })

  it('removing a source from the library still removes its clips on locked tracks', () => {
    st().addSource({
      id: 'src1',
      kind: 'video',
      opfsPath: 'sessions/x.webm',
      mimeType: 'video/webm',
      duration: 10,
      createdAt: 0,
      name: 'x',
    })
    const { a } = setup()
    st().removeSource('src1')
    expect(clip(a)).toBeUndefined()
  })
})

describe('track locks: per-clip content', () => {
  beforeEach(() => {
    st().newProject()
  })

  const lockTrackOf = (clipId: string) =>
    st().updateTrack(clip(clipId)!.trackId, { locked: true })
  const sourceOf = (clipId: string) =>
    st().project.sources.find((x) => x.id === clip(clipId)!.sourceId)!

  it('refuses text edits on a locked track (Inspector edits the text source)', () => {
    const id = st().addTextClip(null, 0, { content: 'Before' })
    lockTrackOf(id)
    st().updateTextStyle(clip(id)!.sourceId, { content: 'After' })
    expect(sourceOf(id).text?.content).toBe('Before')
  })

  it('refuses shape edits on a locked track', () => {
    const id = st().addShapeClip('rect', 0)
    lockTrackOf(id)
    const before = sourceOf(id).shape
    st().updateShape(clip(id)!.sourceId, { fill: '#ff0000' })
    expect(sourceOf(id).shape).toBe(before)
  })

  it('refuses element parameter edits on a locked track', () => {
    const id = st().addElementClip('lowerThird', 0)!
    lockTrackOf(id)
    const before = sourceOf(id).element
    st().updateElementParams(clip(id)!.sourceId, { title: 'Changed' })
    expect(sourceOf(id).element).toBe(before)
  })

  it('still allows renaming a shared recording used on a locked track', () => {
    st().addSource({
      id: 'rec',
      kind: 'video',
      opfsPath: 'sessions/r.webm',
      mimeType: 'video/webm',
      duration: 10,
      createdAt: 0,
      name: 'Old name',
    })
    const t = st().addTrack('video', 'V')
    st().addClip(makeClip({ trackId: t, sourceId: 'rec' }))
    st().updateTrack(t, { locked: true })
    st().updateSource('rec', { name: 'New name' })
    expect(st().project.sources.find((x) => x.id === 'rec')!.name).toBe('New name')
  })
})
