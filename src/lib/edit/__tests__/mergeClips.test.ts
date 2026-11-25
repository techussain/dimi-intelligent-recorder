import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMergeProject, planMerge } from '../mergeClips'
import { useEditor } from '../../timeline/store'
import type { Clip, MediaSource, Project } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

const base = (): Project => ({
  id: 'p',
  name: 'P',
  fps: 30,
  width: 1920,
  height: 1080,
  sampleRate: 48000,
  tracks: [
    { id: 'v2', kind: 'overlay', name: 'V2', muted: false, locked: false, height: 56 },
    { id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false, height: 72 },
    { id: 'a1', kind: 'audio', name: 'A1', muted: false, locked: false, height: 48 },
    { id: 'a2', kind: 'audio', name: 'A2', muted: false, locked: false, height: 48 },
  ],
  clips: [],
  transitions: [],
  sources: [],
  duration: 0,
  createdAt: 0,
  updatedAt: 0,
})

const clip = (o: Partial<Clip> & Pick<Clip, 'id' | 'trackId'>): Clip => ({
  sourceId: 's',
  timelineStart: 0,
  sourceIn: 0,
  sourceOut: 5,
  speed: 1,
  volume: 1,
  transform: { ...identityTransform },
  ...o,
})

describe('planMerge', () => {
  it('covers the selection range and targets the bottom-most visual track', () => {
    const p = base()
    p.clips = [
      clip({ id: 'screen', trackId: 'v1', timelineStart: 2, sourceOut: 10 }),
      clip({ id: 'cam', trackId: 'v2', timelineStart: 3, sourceOut: 4 }),
      clip({ id: 'mic', trackId: 'a2', timelineStart: 1, sourceOut: 12, speed: 2 }),
    ]
    const plan = planMerge(p, ['screen', 'cam', 'mic'])
    expect(plan.start).toBe(1)
    expect(plan.end).toBe(12) // screen ends at 2 + 10
    expect(plan.hasVisual).toBe(true)
    expect(plan.targetTrackId).toBe('v1')
  })

  it('makes an audio-only plan on the top-most selected audio track', () => {
    const p = base()
    p.clips = [
      clip({ id: 'x', trackId: 'a2', timelineStart: 0 }),
      clip({ id: 'y', trackId: 'a1', timelineStart: 5 }),
    ]
    const plan = planMerge(p, ['x', 'y'])
    expect(plan.hasVisual).toBe(false)
    expect(plan.targetTrackId).toBe('a1')
  })

  it('rejects fewer than two clips, live clips and locked targets', () => {
    const p = base()
    p.clips = [
      clip({ id: 'a', trackId: 'v1' }),
      clip({ id: 'b', trackId: 'v1', timelineStart: 5, isLive: true }),
    ]
    expect(() => planMerge(p, ['a'])).toThrow(/at least two/)
    expect(() => planMerge(p, ['a', 'b'])).toThrow(/recording/)
    p.clips[1] = clip({ id: 'b', trackId: 'v1', timelineStart: 5 })
    p.tracks[1] = { ...p.tracks[1]!, locked: true }
    expect(() => planMerge(p, ['a', 'b'])).toThrow(/Unlock/)
  })
})

describe('buildMergeProject', () => {
  it('keeps only the selection, shifted to start at 0, with inner transitions', () => {
    const p = base()
    p.clips = [
      clip({ id: 'a', trackId: 'v1', timelineStart: 10 }),
      clip({ id: 'b', trackId: 'v1', timelineStart: 15 }),
      clip({ id: 'other', trackId: 'v1', timelineStart: 30 }),
    ]
    p.transitions = [
      { id: 't1', fromClipId: 'a', toClipId: 'b', kind: 'crossfade', duration: 1 },
      { id: 't2', fromClipId: 'b', toClipId: 'other', kind: 'crossfade', duration: 1 },
    ]
    const sub = buildMergeProject(p, planMerge(p, ['a', 'b']))
    expect(sub.clips.map((c) => [c.id, c.timelineStart])).toEqual([
      ['a', 0],
      ['b', 5],
    ])
    expect(sub.transitions.map((t) => t.id)).toEqual(['t1'])
    expect(sub.duration).toBe(10)
  })
})

describe('store.replaceWithMergedClip', () => {
  /** addClip takes a clip without an id (the store assigns it). */
  const add = (o: Partial<Omit<Clip, 'id'>> & Pick<Clip, 'trackId'>): string =>
    useEditor.getState().addClip({
      sourceId: 's',
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 5,
      speed: 1,
      volume: 1,
      transform: { ...identityTransform },
      ...o,
    })

  beforeEach(() => {
    useEditor.getState().newProject()
  })

  const merged: MediaSource = {
    id: 'm',
    kind: 'video',
    opfsPath: 'merged/m.webm',
    mimeType: 'video/webm',
    duration: 9,
    createdAt: 0,
    name: 'Merged clip (2 clips)',
  }

  it('swaps the clips for one merged clip in one undo step; undo restores them', () => {
    const st = useEditor.getState()
    const track = st.project.tracks[0]!.id
    const a = add({ trackId: track, timelineStart: 1 })
    const b = add({ trackId: track, timelineStart: 6 })
    const pastBefore = useEditor.getState().past.length

    const id = useEditor
      .getState()
      .replaceWithMergedClip([a, b], merged, { trackId: track, timelineStart: 1 })
    const p = useEditor.getState().project
    expect(id).not.toBeNull()
    expect(p.clips.map((c) => c.id)).toEqual([id])
    expect(p.clips[0]).toMatchObject({ sourceId: 'm', timelineStart: 1, sourceOut: 9 })
    expect(useEditor.getState().selection).toEqual([id])
    expect(useEditor.getState().past.length).toBe(pastBefore + 1)

    useEditor.getState().undo()
    const after = useEditor.getState().project
    expect(after.clips.map((c) => c.id).sort()).toEqual([a, b].sort())
    // The rendered media stays in the library.
    expect(after.sources.some((s) => s.id === 'm')).toBe(true)
  })

  it('refuses while recording', () => {
    const st = useEditor.getState()
    const track = st.project.tracks[0]!.id
    const a = add({ trackId: track })
    const b = add({ trackId: track, timelineStart: 5 })
    useEditor.getState().startRecording()
    expect(
      useEditor
        .getState()
        .replaceWithMergedClip([a, b], merged, { trackId: track, timelineStart: 0 }),
    ).toBeNull()
    useEditor.getState().stopRecording()
  })
})
