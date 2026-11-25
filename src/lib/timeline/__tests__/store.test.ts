/**
 * Undo/redo idempotency.
 *
 * Verifies that applying a series of mutations and then undoing them all
 * restores the project to its original state, and that redoing them all
 * restores the post-mutation state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../store'
import type { Clip, MediaSource, Project } from '../types'
import { identityTransform } from '../types'
import { clipEndSec } from '../selectors'

// blobCache imports the OPFS API which is unavailable in jsdom.
vi.mock('../../storage/blobCache', () => ({
  releaseAll: vi.fn(),
}))

// idb-keyval is used lazily; the store creates an IDB handle at module load.
// The handle itself doesn't open the DB, so no mock is needed.

// ─── helpers ─────────────────────────────────────────────────────────────────

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

/** Snapshot only the plain-data portion of the project for comparison. */
function projectSnapshot(): string {
  return JSON.stringify(useEditor.getState().project)
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('store undo/redo idempotency', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('restores initial state after undoing all operations', () => {
    const initial = projectSnapshot()

    const trackId = useEditor.getState().addTrack('video', 'Test V')
    const clipId1 = useEditor
      .getState()
      .addClip(makeClip({ trackId, timelineStart: 0 }))
    const clipId2 = useEditor
      .getState()
      .addClip(makeClip({ trackId, timelineStart: 5 }))
    useEditor.getState().moveClip(clipId1, 2)
    useEditor.getState().trimClip(clipId2, 'start', 0.5)
    useEditor.getState().addMarker({ time: 3, label: 'mark' })

    const steps = useEditor.getState().past.length
    expect(steps).toBeGreaterThan(0)

    for (let i = 0; i < steps; i++) {
      useEditor.getState().undo()
    }

    expect(projectSnapshot()).toBe(initial)
  })

  it('restores post-mutation state after redo-all', () => {
    const trackId = useEditor.getState().addTrack('audio', 'Test A')
    useEditor.getState().addClip(makeClip({ trackId, timelineStart: 2, sourceOut: 5 }))
    useEditor.getState().addClip(makeClip({ trackId, timelineStart: 8, sourceOut: 3 }))

    const afterMutations = projectSnapshot()
    const steps = useEditor.getState().past.length

    for (let i = 0; i < steps; i++) {
      useEditor.getState().undo()
    }

    const redoSteps = useEditor.getState().future.length
    for (let i = 0; i < redoSteps; i++) {
      useEditor.getState().redo()
    }

    expect(projectSnapshot()).toBe(afterMutations)
  })

  it('canUndo / canRedo correctly reflect history', () => {
    expect(useEditor.getState().canUndo()).toBe(false)
    expect(useEditor.getState().canRedo()).toBe(false)

    const trackId = useEditor.getState().addTrack('video', 'V')
    useEditor.getState().addClip(makeClip({ trackId }))

    expect(useEditor.getState().canUndo()).toBe(true)
    expect(useEditor.getState().canRedo()).toBe(false)

    useEditor.getState().undo()
    expect(useEditor.getState().canRedo()).toBe(true)

    useEditor.getState().redo()
    expect(useEditor.getState().canRedo()).toBe(false)
  })

  it('undo/redo handles splitAt correctly', () => {
    const trackId = useEditor.getState().addTrack('video', 'Splittable')
    useEditor.getState().addClip(makeClip({ trackId, timelineStart: 0, sourceOut: 20 }))

    const beforeSplit = projectSnapshot()
    useEditor.getState().splitAt(10)
    const afterSplit = projectSnapshot()

    expect(afterSplit).not.toBe(beforeSplit)

    // Undo the split (and any ops before it that are now in past)
    const beforeSplitClipCount = (JSON.parse(beforeSplit) as Project).clips.length
    const afterSplitClipCount = (JSON.parse(afterSplit) as Project).clips.length
    expect(afterSplitClipCount).toBeGreaterThan(beforeSplitClipCount)

    useEditor.getState().undo()
    expect(projectSnapshot()).toBe(beforeSplit)
  })

  it('removeClip is undoable', () => {
    const trackId = useEditor.getState().addTrack('video', 'V')
    const clipId = useEditor.getState().addClip(makeClip({ trackId }))
    const withClip = projectSnapshot()

    useEditor.getState().removeClip(clipId)
    expect(useEditor.getState().project.clips).toHaveLength(0)

    useEditor.getState().undo()
    expect(projectSnapshot()).toBe(withClip)
  })
})

describe('store recording / load guards', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('freezes undo/redo while a recording is active', () => {
    const trackId = useEditor.getState().addTrack('video', 'V')
    useEditor.getState().addClip(makeClip({ trackId }))
    const beforeRecording = projectSnapshot()
    expect(useEditor.getState().past.length).toBeGreaterThan(0)

    useEditor.getState().startRecording()
    // Undo would swap the whole project out from under the recorder — must no-op.
    useEditor.getState().undo()
    expect(projectSnapshot()).toBe(beforeRecording)
    useEditor.getState().redo()
    expect(projectSnapshot()).toBe(beforeRecording)

    // Once recording stops, history works again. The take itself is one undo
    // step (pushed at startRecording), so the first undo lands on the
    // pre-recording timeline and the next one undoes the addClip.
    useEditor.getState().stopRecording()
    useEditor.getState().undo()
    expect(projectSnapshot()).toBe(beforeRecording)
    useEditor.getState().undo()
    expect(projectSnapshot()).not.toBe(beforeRecording)
  })

  it('clears leftover isLive flags on loadProject (post-crash recovery)', () => {
    const base = useEditor.getState().project
    const liveClip: Clip = {
      id: 'c-live',
      trackId: base.tracks[0]?.id ?? '',
      sourceId: 's1',
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 5,
      speed: 1,
      transform: { ...identityTransform },
      volume: 1,
      isLive: true,
    }
    const loaded: Project = { ...base, clips: [liveClip] }
    useEditor.getState().loadProject(loaded)
    expect(useEditor.getState().project.clips[0]?.isLive).toBeFalsy()
  })

  it('removeSource is undoable and restores the source (no eager OPFS delete)', () => {
    const src: MediaSource = {
      id: 's-x',
      kind: 'video',
      opfsPath: 'sessions/x.webm',
      mimeType: 'video/webm',
      duration: 3,
      createdAt: 0,
      name: 'x',
    }
    useEditor.getState().addSource(src)
    useEditor.getState().removeSource('s-x')
    expect(
      useEditor.getState().project.sources.find((s) => s.id === 's-x'),
    ).toBeUndefined()

    // The file was NOT deleted eagerly, so undo restores fully-usable media.
    useEditor.getState().undo()
    expect(useEditor.getState().project.sources.find((s) => s.id === 's-x')?.id).toBe(
      's-x',
    )
  })

  it('redo of removeSource removes it again, but keeps media imported meanwhile', () => {
    const media = (id: string): MediaSource => ({
      id,
      kind: 'video',
      opfsPath: `sessions/${id}.webm`,
      mimeType: 'video/webm',
      duration: 3,
      createdAt: 0,
      name: id,
    })
    const has = (id: string) =>
      useEditor.getState().project.sources.some((s) => s.id === id)
    useEditor.getState().addSource(media('s-x'))
    useEditor.getState().removeSource('s-x')
    useEditor.getState().undo()
    expect(has('s-x')).toBe(true)
    // An import between undo and redo has no history entry of its own.
    useEditor.getState().addSource(media('s-new'))
    useEditor.getState().redo()
    expect(has('s-x')).toBe(false)
    expect(has('s-new')).toBe(true)
  })
})

describe('store: media survives undo, takes are atomic, live clips are protected', () => {
  const media = (id: string): MediaSource => ({
    id,
    kind: 'video',
    opfsPath: `sessions/${id}.webm`,
    mimeType: 'video/webm',
    duration: 3,
    createdAt: 0,
    name: id,
  })

  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('undo after an import keeps the imported media in the library', () => {
    const trackId = useEditor.getState().addTrack('video', 'V')
    useEditor.getState().addClip(makeClip({ trackId }))
    useEditor.getState().addSource(media('imported'))

    useEditor.getState().undo() // undoes addClip, not the import
    const ids = useEditor.getState().project.sources.map((s) => s.id)
    expect(ids).toContain('imported')
    expect(useEditor.getState().project.clips).toHaveLength(0)

    useEditor.getState().redo()
    expect(useEditor.getState().project.sources.map((s) => s.id)).toContain('imported')
  })

  it('undo does not resurrect text sources whose clip was undone', () => {
    useEditor.getState().addTextClip(null, 0)
    expect(useEditor.getState().project.sources).toHaveLength(1)
    useEditor.getState().undo()
    expect(useEditor.getState().project.sources).toHaveLength(0)
  })

  it('an edit made during a take does not restore a truncated live stub on undo', () => {
    const st = useEditor.getState()
    const screen = st.project.tracks[0]?.id ?? ''
    const audio = st.project.tracks[2]?.id ?? ''
    const other = st.addClip(
      makeClip({ trackId: audio, sourceId: 'a', timelineStart: 20 }),
    )

    useEditor.getState().startRecording()
    useEditor.getState().addSource(media('take'))
    const live = useEditor
      .getState()
      .addClip(
        makeClip({ trackId: screen, sourceId: 'take', sourceOut: 2, isLive: true }),
      )
    useEditor.getState().moveClip(other, 1) // snapshot holds live clip @ 2s
    useEditor.getState().extendLiveClip(live, 30)
    useEditor.getState().stopRecording()

    useEditor.getState().undo() // undo the move
    const clip = useEditor.getState().project.clips.find((c) => c.id === live)
    expect(clip?.isLive).toBeFalsy()
    expect(clip?.sourceOut).toBe(30)
  })

  it('one undo after Stop removes the take but keeps its media', () => {
    const screen = useEditor.getState().project.tracks[0]?.id ?? ''
    useEditor.getState().startRecording()
    useEditor.getState().addSource(media('take'))
    useEditor
      .getState()
      .addClip(
        makeClip({ trackId: screen, sourceId: 'take', sourceOut: 5, isLive: true }),
      )
    useEditor.getState().stopRecording()

    useEditor.getState().undo()
    expect(useEditor.getState().project.clips).toHaveLength(0)
    expect(useEditor.getState().project.sources.map((s) => s.id)).toContain('take')
  })

  it('refuses destructive edits on a live clip', () => {
    const screen = useEditor.getState().project.tracks[0]?.id ?? ''
    useEditor.getState().startRecording()
    useEditor.getState().addSource(media('take'))
    const live = useEditor
      .getState()
      .addClip(
        makeClip({ trackId: screen, sourceId: 'take', sourceOut: 5, isLive: true }),
      )
    const before = projectSnapshot()
    useEditor.getState().trimClip(live, 'end', -1)
    useEditor.getState().moveClip(live, 3)
    useEditor.getState().updateClip(live, { sourceOut: 1 })
    useEditor.getState().removeClip(live)
    useEditor.getState().rippleDeleteClip(live)
    useEditor.getState().removeTrack(screen)
    useEditor.getState().removeSource('take')
    expect(projectSnapshot()).toBe(before)
    useEditor.getState().stopRecording()
  })

  it('refuses newProject / loadProject while recording', () => {
    useEditor.getState().startRecording()
    const id = useEditor.getState().project.id
    expect(useEditor.getState().newProject()).toBe(false)
    expect(
      useEditor
        .getState()
        .loadProject({ ...useEditor.getState().project, id: 'other' }),
    ).toBe(false)
    expect(useEditor.getState().project.id).toBe(id)
    useEditor.getState().stopRecording()
    expect(useEditor.getState().newProject()).toBe(true)
  })
})

describe('store: structural-sharing history', () => {
  const st = () => useEditor.getState()
  beforeEach(() => {
    st().newProject()
  })

  it('history entries reference the previous project instead of cloning it', () => {
    const before = st().project
    st().addTrack('video', 'V')
    expect(st().past[st().past.length - 1]?.project).toBe(before)
  })

  it('no-op edits push no history and leave updatedAt alone', () => {
    const trackId = st().project.tracks[0]!.id
    const updatedAt = st().project.updatedAt
    st().updateTrack('missing', { name: 'x' })
    st().updateTrack(trackId, { name: st().project.tracks[0]!.name })
    st().removeClip('missing')
    st().moveTrack(trackId, -5) // already first
    st().splitAt(3) // nothing to split
    st().removeMarker('missing')
    expect(st().past).toHaveLength(0)
    expect(st().project.updatedAt).toBe(updatedAt)
  })

  it('bumps updatedAt on every project edit', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      st().newProject()
      vi.setSystemTime(5_000)
      st().addMarker({ time: 1, label: 'm' })
      expect(st().project.updatedAt).toBe(5_000)
      vi.setSystemTime(6_000)
      st().updateTrack(st().project.tracks[0]!.id, { muted: true })
      expect(st().project.updatedAt).toBe(6_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an interaction that changed nothing pushes no entry; one that did pushes one', () => {
    const trackId = st().addTrack('video', 'V')
    const clip = st().addClip(makeClip({ trackId, timelineStart: 5 }))
    const depth = st().past.length
    st().beginInteraction()
    st().moveClip(clip, 0)
    st().endInteraction()
    expect(st().past).toHaveLength(depth)

    st().beginInteraction()
    st().moveClip(clip, 1)
    st().moveClip(clip, 1)
    st().endInteraction()
    expect(st().past).toHaveLength(depth + 1)
    st().undo()
    expect(st().project.clips[0]?.timelineStart).toBe(5)
  })

  it('blocks undo/redo while an interaction is open', () => {
    const trackId = st().addTrack('video', 'V')
    const clip = st().addClip(makeClip({ trackId, timelineStart: 5 }))
    st().beginInteraction()
    st().moveClip(clip, 2)
    st().undo()
    expect(st().project.clips[0]?.timelineStart).toBe(7)
    st().endInteraction()
    st().undo()
    expect(st().project.clips[0]?.timelineStart).toBe(5)
    expect(st().canRedo()).toBe(true)
  })

  it('resetInteraction closes a leaked interaction and commits its change', () => {
    const trackId = st().addTrack('video', 'V')
    const clip = st().addClip(makeClip({ trackId, timelineStart: 5 }))
    st().beginInteraction()
    st().beginInteraction()
    st().moveClip(clip, 1)
    st().resetInteraction() // pointerup was missed
    expect(st()._interactionDepth).toBe(0)
    expect(st()._interactionSnapshot).toBeNull()
    st().undo()
    expect(st().project.clips[0]?.timelineStart).toBe(5)
    st().resetInteraction() // no-op when nothing is open
    expect(st()._interactionDepth).toBe(0)
  })
})

describe('store: splitAt', () => {
  const st = () => useEditor.getState()
  beforeEach(() => {
    st().newProject()
  })

  it('re-bases keyframes and inserts a continuous boundary keyframe', () => {
    const trackId = st().addTrack('video', 'V')
    const id = st().addClip(makeClip({ trackId, timelineStart: 10, sourceOut: 10 }))
    st().setKeyframe(id, 'opacity', { t: 0, value: 0 })
    st().setKeyframe(id, 'opacity', { t: 8, value: 1 })
    st().splitAt(14) // clip-local 4 → value 0.5
    const [left, right] = st().project.clips
    expect(left?.keyframes?.opacity).toEqual([
      { t: 0, value: 0 },
      { t: 4, value: 0.5 },
    ])
    expect(right?.keyframes?.opacity).toEqual([
      { t: 0, value: 0.5 },
      { t: 4, value: 1 },
    ])
    expect(right?.timelineStart).toBe(14)
    expect(right?.sourceIn).toBe(4)
    expect(left?.sourceOut).toBe(4)
  })

  it('halves do not share transform/color/keyframe objects', () => {
    const trackId = st().addTrack('video', 'V')
    const id = st().addClip(makeClip({ trackId, sourceOut: 10 }))
    st().setColor(id, { brightness: 1.2 })
    st().setKeyframe(id, 'x', { t: 1, value: 3 })
    st().splitAt(5)
    const [left, right] = st().project.clips
    expect(left?.transform).not.toBe(right?.transform)
    expect(left?.color).not.toBe(right?.color)
    expect(left?.color).toEqual(right?.color)
    expect(left?.keyframes?.x).not.toBe(right?.keyframes?.x)
    st().setTransform(right!.id, { x: 50 })
    expect(st().project.clips[0]?.transform.x).toBe(0)
  })

  it('re-points outgoing transitions at the right half', () => {
    const trackId = st().addTrack('video', 'V')
    const a = st().addClip(makeClip({ trackId, sourceOut: 10 }))
    const b = st().addClip(makeClip({ trackId, timelineStart: 10, sourceOut: 10 }))
    const z = st().addClip(
      makeClip({ trackId: st().project.tracks[0]!.id, sourceOut: 1 }),
    )
    st().addTransition({ fromClipId: a, toClipId: b, kind: 'crossfade', duration: 1 })
    st().addTransition({ fromClipId: z, toClipId: a, kind: 'crossfade', duration: 1 })
    st().splitAt(5, undefined, [a])
    const right = st().project.clips.find((c) => c.id !== a && c.timelineStart === 5)!
    const [out, into] = st().project.transitions
    expect(out?.fromClipId).toBe(right.id)
    expect(into?.toClipId).toBe(a) // incoming stays on the left half
  })
})

describe('store: trim / move bounds', () => {
  const st = () => useEditor.getState()
  const src = (duration: number): MediaSource => ({
    id: 'v',
    kind: 'video',
    opfsPath: 'imports/v.webm',
    mimeType: 'video/webm',
    duration,
    createdAt: 0,
    name: 'v',
  })
  beforeEach(() => {
    st().newProject()
  })

  it('start-trim at timeline 0 cannot extend left or move the end', () => {
    const trackId = st().addTrack('video', 'V')
    const id = st().addClip(
      makeClip({ trackId, timelineStart: 0, sourceIn: 3, sourceOut: 8 }),
    )
    st().trimClip(id, 'start', -2)
    const c = st().project.clips[0]!
    expect(c.timelineStart).toBe(0)
    expect(c.sourceIn).toBe(3)
    expect(c.sourceOut).toBe(8)
  })

  it('start-trim extends left only as far as timeline 0 allows, keeping the end', () => {
    const trackId = st().addTrack('video', 'V')
    const id = st().addClip(
      makeClip({ trackId, timelineStart: 1, sourceIn: 3, sourceOut: 8 }),
    )
    st().trimClip(id, 'start', -2)
    const c = st().project.clips[0]!
    expect(c.timelineStart).toBe(0)
    expect(c.sourceIn).toBe(2)
    expect(c.timelineStart + (c.sourceOut - c.sourceIn)).toBe(6)
  })

  it('end-trim and updateClip cannot exceed the source duration', () => {
    st().addSource(src(10))
    const trackId = st().addTrack('video', 'V')
    const id = st().addClip(makeClip({ trackId, sourceId: 'v', sourceOut: 8 }))
    st().trimClip(id, 'end', 5)
    expect(st().project.clips[0]?.sourceOut).toBe(10)
    st().updateClip(id, { sourceOut: 30 })
    expect(st().project.clips[0]?.sourceOut).toBe(10)
  })

  it('end-trim of text clips is unbounded', () => {
    const id = st().addTextClip(null, 0)
    st().trimClip(id, 'end', 6)
    expect(st().project.clips[0]?.sourceOut).toBe(10)
  })

  it('moveClip only changes to a compatible, unlocked track', () => {
    const [v1, v2] = st().project.tracks
    const id = st().addClip(makeClip({ trackId: v2!.id }))
    st().moveClip(id, 0, 1) // overlay → audio: refused
    expect(st().project.clips[0]?.trackId).toBe(v2!.id)
    st().updateTrack(v1!.id, { locked: true })
    st().moveClip(id, 0, -1) // locked: refused
    expect(st().project.clips[0]?.trackId).toBe(v2!.id)
    st().updateTrack(v1!.id, { locked: false })
    st().moveClip(id, 0, -1)
    expect(st().project.clips[0]?.trackId).toBe(v1!.id)
  })

  it('moveClips moves many clips (and link groups) as one step with a shared clamp', () => {
    const trackId = st().addTrack('video', 'V')
    const a = st().addClip(makeClip({ trackId, timelineStart: 1 }))
    const b = st().addClip(makeClip({ trackId, timelineStart: 20 }))
    const linked = st().addClip(makeClip({ trackId, timelineStart: 40 }))
    st().linkClips([b, linked])
    const depth = st().past.length
    st().moveClips([a, b], -5)
    const at = (id: string) =>
      st().project.clips.find((c) => c.id === id)?.timelineStart
    expect(at(a)).toBe(0)
    expect(at(b)).toBe(19)
    expect(at(linked)).toBe(39)
    expect(st().past).toHaveLength(depth + 1)
  })

  it('removeClips / rippleDeleteClips are single undo steps', () => {
    const trackId = st().addTrack('video', 'V')
    const a = st().addClip(makeClip({ trackId, timelineStart: 0, sourceOut: 2 }))
    const b = st().addClip(makeClip({ trackId, timelineStart: 2, sourceOut: 2 }))
    const c = st().addClip(makeClip({ trackId, timelineStart: 6, sourceOut: 2 }))
    const depth = st().past.length
    st().rippleDeleteClips([a, b])
    expect(st().project.clips.map((x) => x.id)).toEqual([c])
    expect(st().project.clips[0]?.timelineStart).toBe(2)
    expect(st().past).toHaveLength(depth + 1)
    st().undo()
    expect(st().project.clips).toHaveLength(3)
    st().removeClips([a, c])
    expect(st().project.clips.map((x) => x.id)).toEqual([b])
    expect(st().past).toHaveLength(depth + 1)
  })

  it('linkClips merges existing groups instead of splitting them', () => {
    const trackId = st().addTrack('video', 'V')
    st().addClip(makeClip({ trackId }))
    const b = st().addClip(makeClip({ trackId }))
    const c = st().addClip(makeClip({ trackId }))
    const a = st().project.clips[0]!.id
    st().linkClips([a, b])
    st().linkClips([b, c])
    const groups = new Set(st().project.clips.map((x) => x.linkGroup))
    expect(groups.size).toBe(1)
    expect([...groups][0]).toBeTruthy()
  })
})

describe('store: coalescing, text, sources', () => {
  const st = () => useEditor.getState()
  beforeEach(() => {
    st().newProject()
  })

  it('coalesces rapid project-name edits into one undo step', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      st().setProjectName('A')
      vi.setSystemTime(10_300)
      st().setProjectName('AB')
      vi.setSystemTime(10_600)
      st().setProjectName('ABC')
      expect(st().past).toHaveLength(1)
      vi.setSystemTime(20_000)
      st().setProjectName('ABCD') // after a pause: new step
      expect(st().past).toHaveLength(2)
      st().undo()
      expect(st().project.name).toBe('ABC')
      st().undo()
      expect(st().project.name).toBe('Untitled Project')
    } finally {
      vi.useRealTimers()
    }
  })

  it('updateTextStyle is undoable and renames the source', () => {
    st().addTextClip(null, 0, { content: 'Hello' })
    const sid = st().project.sources[0]!.id
    st().updateTextStyle(sid, { content: 'World', fontSize: 40 })
    expect(st().project.sources[0]?.text?.content).toBe('World')
    expect(st().project.sources[0]?.name).toBe('World')
    st().undo()
    expect(st().project.sources[0]?.text?.content).toBe('Hello')
    expect(st().project.sources[0]?.text?.fontSize).toBe(72)
  })

  it('updateSource media fields skip history and patch snapshots; name is undoable', () => {
    st().addSource({
      id: 's',
      kind: 'video',
      opfsPath: 'sessions/a/raw.webm',
      mimeType: 'video/webm',
      duration: 0,
      createdAt: 0,
      name: 'raw',
    })
    const trackId = st().project.tracks[0]!.id
    st().addClip(makeClip({ trackId, sourceId: 's' }))
    const depth = st().past.length
    st().updateSource('s', { opfsPath: 'sessions/a/remuxed.mp4', duration: 12 })
    expect(st().past).toHaveLength(depth)
    for (const e of st().past) {
      const s = e.project.sources.find((x) => x.id === 's')
      if (s) expect(s.opfsPath).toBe('sessions/a/remuxed.mp4')
    }
    st().updateSource('s', { name: 'Take 1' })
    expect(st().past).toHaveLength(depth + 1)
    st().undo()
    const s = st().project.sources.find((x) => x.id === 's')
    expect(s?.name).toBe('raw')
    expect(s?.opfsPath).toBe('sessions/a/remuxed.mp4')
    expect(s?.duration).toBe(12)
  })

  it('newProject releases cached blob URLs', async () => {
    const { releaseAll } = await import('../../storage/blobCache')
    vi.mocked(releaseAll).mockClear()
    st().newProject()
    expect(releaseAll).toHaveBeenCalledTimes(1)
  })
})

describe('reconcileRecordedClip', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('corrects an untrimmed take without an undo step, including in history', () => {
    const screen = useEditor.getState().project.tracks[0]?.id ?? ''
    const audio = useEditor.getState().project.tracks[2]?.id ?? ''
    useEditor.getState().startRecording()
    const live = useEditor
      .getState()
      .addClip(
        makeClip({ trackId: screen, sourceId: 'take', sourceOut: 9.8, isLive: true }),
      )
    useEditor.getState().stopRecording()
    useEditor
      .getState()
      .addClip(makeClip({ trackId: audio, sourceId: 'a', timelineStart: 20 }))
    const pastLen = useEditor.getState().past.length

    useEditor.getState().reconcileRecordedClip(live, 9.8, 10.03)
    expect(useEditor.getState().past.length).toBe(pastLen)
    expect(
      useEditor.getState().project.clips.find((c) => c.id === live)?.sourceOut,
    ).toBe(10.03)

    useEditor.getState().undo() // undo the audio clip; the take keeps its real length
    expect(
      useEditor.getState().project.clips.find((c) => c.id === live)?.sourceOut,
    ).toBe(10.03)
  })

  it('keeps every clip of a take ending together, whatever the file lengths', () => {
    // Live: both clips end at 5 (the audio recorder reported starting 0.3 s
    // earlier, so its clip skips 0.3 s). Real files: video 5.4 s, audio 5.1 s.
    const [screen, , audio] = useEditor.getState().project.tracks.map((t) => t.id)
    useEditor.getState().startRecording()
    const v = useEditor
      .getState()
      .addClip(
        makeClip({ trackId: screen!, sourceId: 'v', sourceOut: 5, isLive: true }),
      )
    const a = useEditor.getState().addClip(
      makeClip({
        trackId: audio!,
        sourceId: 'a',
        sourceIn: 0.3,
        sourceOut: 5.3,
        isLive: true,
      }),
    )
    useEditor.getState().finalizeLiveClips()
    useEditor.getState().stopRecording()
    useEditor.getState().reconcileRecordedClip(v, 5, 5.4)
    useEditor.getState().reconcileRecordedClip(a, 5.3, 5.1)
    const get = (id: string) =>
      useEditor.getState().project.clips.find((c) => c.id === id)!
    expect(get(v)).toMatchObject({ timelineStart: 0, sourceOut: 5.4 })
    expect(get(v).sourceIn).toBeCloseTo(0.4)
    expect(get(a)).toMatchObject({ timelineStart: 0, sourceOut: 5.1 })
    expect(get(a).sourceIn).toBeCloseTo(0.1)
    expect(clipEndSec(get(v))).toBeCloseTo(5)
    expect(clipEndSec(get(a))).toBeCloseTo(5)
  })

  it('starts a clip later when its file is too short to reach back to the take start', () => {
    const screen = useEditor.getState().project.tracks[0]!.id
    useEditor.getState().startRecording()
    const v = useEditor.getState().addClip(
      makeClip({
        trackId: screen,
        sourceId: 'v',
        timelineStart: 2,
        sourceOut: 5,
        isLive: true,
      }),
    )
    useEditor.getState().finalizeLiveClips()
    useEditor.getState().stopRecording()
    useEditor.getState().reconcileRecordedClip(v, 5, 4.8)
    const c = useEditor.getState().project.clips.find((x) => x.id === v)!
    expect(c.sourceIn).toBe(0)
    expect(c.sourceOut).toBe(4.8)
    expect(c.timelineStart).toBeCloseTo(2.2)
    expect(clipEndSec(c)).toBeCloseTo(7)
  })

  it('leaves a clip the user trimmed alone', () => {
    const screen = useEditor.getState().project.tracks[0]?.id ?? ''
    const id = useEditor.getState().addClip(makeClip({ trackId: screen, sourceOut: 5 }))
    useEditor.getState().reconcileRecordedClip(id, 9.8, 10.03)
    expect(useEditor.getState().project.clips.find((c) => c.id === id)?.sourceOut).toBe(
      5,
    )
  })
})

describe('store: setTransforms', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('patches several clips as one undo step', () => {
    const st = () => useEditor.getState()
    const trackId = st().addTrack('overlay', 'O')
    const trackId2 = st().addTrack('overlay', 'O2')
    const a = st().addClip(makeClip({ trackId }))
    const b = st().addClip(makeClip({ trackId: trackId2 }))
    const before = st().past.length

    st().setTransforms([
      { id: a, patch: { x: 10, y: 20 } },
      { id: b, patch: { x: -5 } },
    ])
    expect(st().past.length).toBe(before + 1)
    const clips = st().project.clips
    expect(clips.find((c) => c.id === a)?.transform).toMatchObject({ x: 10, y: 20 })
    expect(clips.find((c) => c.id === b)?.transform.x).toBe(-5)

    st().undo()
    const undone = st().project.clips
    expect(undone.find((c) => c.id === a)?.transform.x).toBe(0)
    expect(undone.find((c) => c.id === b)?.transform.x).toBe(0)
  })

  it('records nothing when no value changes', () => {
    const st = () => useEditor.getState()
    const trackId = st().addTrack('overlay', 'O')
    const a = st().addClip(makeClip({ trackId }))
    const before = st().past.length
    const project = st().project
    st().setTransforms([{ id: a, patch: { x: 0, y: 0 } }])
    st().setTransforms([])
    expect(st().past.length).toBe(before)
    expect(st().project).toBe(project)
  })

  it('skips live clips', () => {
    const st = () => useEditor.getState()
    const trackId = st().addTrack('overlay', 'O')
    const trackId2 = st().addTrack('overlay', 'O2')
    const live = st().addClip(makeClip({ trackId, isLive: true }))
    const done = st().addClip(makeClip({ trackId: trackId2 }))
    st().setTransforms([
      { id: live, patch: { x: 50 } },
      { id: done, patch: { x: 50 } },
    ])
    const clips = st().project.clips
    expect(clips.find((c) => c.id === live)?.transform.x).toBe(0)
    expect(clips.find((c) => c.id === done)?.transform.x).toBe(50)

    const before = st().past.length
    st().setTransforms([{ id: live, patch: { x: 99 } }])
    expect(st().past.length).toBe(before)
  })

  it('coalesces a quick burst with the same key into one undo step', () => {
    const st = () => useEditor.getState()
    const trackId = st().addTrack('overlay', 'O')
    const a = st().addClip(makeClip({ trackId }))
    const before = st().past.length
    for (let i = 1; i <= 5; i++)
      st().setTransforms([{ id: a, patch: { x: i } }], 'nudge')
    expect(st().past.length).toBe(before + 1)
    st().undo()
    expect(st().project.clips.find((c) => c.id === a)?.transform.x).toBe(0)
  })
})

describe('default project stacking', () => {
  it('paints the webcam above the screen recording', async () => {
    const { buildScene } = await import('../../compositor/scene')
    useEditor.getState().newProject()
    const st = useEditor.getState()
    const role = (r: string) => st.project.tracks.find((t) => t.role === r)!.id
    for (const [id, kind] of [
      ['screen-src', 'video'],
      ['cam-src', 'video'],
    ] as const)
      st.addSource({
        id,
        kind,
        opfsPath: `sessions/${id}.webm`,
        mimeType: 'video/webm',
        duration: 10,
        createdAt: 0,
        name: id,
      })
    st.addClip(makeClip({ trackId: role('screen'), sourceId: 'screen-src' }))
    st.addClip(makeClip({ trackId: role('webcam'), sourceId: 'cam-src' }))
    const scene = buildScene(useEditor.getState().project, 1, { includeLive: false })
    // Paint order is bottom → top: the webcam must come last.
    expect(scene.map((g) => g.track.role)).toEqual(['screen', 'webcam'])
  })
})
