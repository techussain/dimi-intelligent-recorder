/**
 * Effects through edits: store actions (overlap rule, kinds, undo), split,
 * silence-removal cuts, duplicate, and fade suppression at transitions in
 * video sampling and the export audio plan.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../../timeline/store'
import { cutTimeRanges } from '../../timeline/cutRanges'
import { duplicateClipData } from '../../timeline/duplicate'
import { planClipAudio, sampleVolumeCurve } from '../../export/audioPlan'
import { fadeEdges } from '../sample'
import { effectiveFade } from '../timing'
import {
  createFade,
  createShake,
  createSpotlight,
  createZoom,
  type ClipEffect,
  type FadeEffect,
} from '../types'
import { freeZoomRange, splitEffects } from '../edit'
import type { Clip, MediaSource, Project } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

function clip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId: 'v1',
    sourceId: 's1',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 10,
    speed: 1,
    transform: { ...identityTransform },
    volume: 1,
    ...over,
  }
}

function source(id: string, kind: MediaSource['kind'] = 'video'): MediaSource {
  return {
    id,
    kind,
    opfsPath: kind === 'text' ? '' : id,
    mimeType: 'video/webm',
    duration: 60,
    createdAt: 0,
    name: id,
  }
}

function project(clips: Clip[], over: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'p',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false, height: 72 },
    ],
    clips,
    transitions: [],
    sources: [source('s1')],
    duration: 10,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const fadeOf = (c: Clip | undefined) =>
  c?.effects?.find((e): e is FadeEffect => e.type === 'fade')

// ─── store actions ───────────────────────────────────────────────────────────

describe('store effect actions', () => {
  let clipId: string
  beforeEach(() => {
    const st = useEditor.getState()
    st.newProject()
    st.loadProject(project([clip('c1', { sourceOut: 30 })]))
    clipId = 'c1'
  })
  const get = () => useEditor.getState().project.clips.find((c) => c.id === clipId)

  it('adds, updates, toggles and removes as undoable steps', () => {
    const st = useEditor.getState()
    const id = st.addEffect(clipId, createZoom(1, 3))
    expect(id).toBeTruthy()
    expect(get()?.effects).toHaveLength(1)
    expect(st.updateEffect(clipId, id!, { scale: 3 })).toBe(true)
    expect(get()?.effects?.[0]).toMatchObject({ scale: 3 })
    st.toggleEffect(clipId, id!)
    expect(get()?.effects?.[0]?.enabled).toBe(false)
    st.removeEffect(clipId, id!)
    expect(get()?.effects).toBeUndefined()
    st.undo()
    st.undo()
    expect(get()?.effects?.[0]).toMatchObject({ scale: 3, enabled: true })
    st.undo()
    st.undo()
    expect(get()?.effects).toBeUndefined()
  })

  it('rejects overlapping zooms but allows adjacent ones', () => {
    const st = useEditor.getState()
    expect(st.addEffect(clipId, createZoom(2, 5))).toBeTruthy()
    expect(st.addEffect(clipId, createZoom(4, 6))).toBeNull()
    expect(st.addEffect(clipId, createZoom(0, 2.5))).toBeNull()
    const b = st.addEffect(clipId, createZoom(5, 7))
    expect(b).toBeTruthy()
    // Spotlights / shakes may overlap zooms.
    expect(st.addEffect(clipId, createSpotlight(3, 6))).toBeTruthy()
    // Moving b into the first zoom is refused, unchanged.
    expect(st.updateEffect(clipId, b!, { start: 4, end: 6 })).toBe(false)
    expect(get()?.effects?.find((e) => e.id === b)).toMatchObject({ start: 5, end: 7 })
  })

  it('normalizes values and refuses a second fade', () => {
    const st = useEditor.getState()
    const id = st.addEffect(clipId, { ...createZoom(3, 2), scale: 50, focusX: -1 })
    expect(get()?.effects?.find((e) => e.id === id)).toMatchObject({
      start: 3,
      end: 3.1,
      scale: 8,
      focusX: 0,
    })
    expect(st.addEffect(clipId, createFade())).toBeTruthy()
    expect(st.addEffect(clipId, createFade())).toBeNull()
  })

  it('refuses crop effects on text sources but allows zoom (grow) / fade / shake', () => {
    const st = useEditor.getState()
    const textClip = st.addTextClip(null, 0)
    expect(st.addEffect(textClip, createZoom(0, 1, { mode: 'grow' }))).toBeTruthy()
    expect(st.addEffect(textClip, createSpotlight(0, 1))).toBeNull()
    expect(st.addEffect(textClip, createFade())).toBeTruthy()
    expect(st.addEffect(textClip, createShake(0, 1))).toBeTruthy()
  })

  it('a slider drag inside begin/endInteraction is one undo step', () => {
    const st = useEditor.getState()
    const id = st.addEffect(clipId, createZoom(1, 3))!
    const before = useEditor.getState().past.length
    st.beginInteraction()
    for (const v of [1.2, 1.5, 2.5]) st.updateEffect(clipId, id, { scale: v })
    st.endInteraction()
    expect(useEditor.getState().past.length).toBe(before + 1)
  })
})

// ─── split / cut / duplicate ─────────────────────────────────────────────────

describe('split keeps effects and drops fades at the cut', () => {
  it('splitAt: left loses fade-out, right loses fade-in; ranges copied', () => {
    const st = useEditor.getState()
    st.newProject()
    const z = createZoom(6, 8)
    st.loadProject(
      project([clip('c1', { effects: [createFade({ in: 1, out: 2 }), z] })]),
    )
    st.splitAt(5)
    const [left, right] = useEditor.getState().project.clips
    expect(fadeOf(left)).toMatchObject({ in: 1, out: 0 })
    expect(fadeOf(right)).toMatchObject({ in: 0, out: 2 })
    // Source-anchored: same source range on both halves (hidden on the left).
    expect(left?.effects?.find((e) => e.type === 'zoom')).toMatchObject({
      start: 6,
      end: 8,
    })
    expect(right?.effects?.find((e) => e.type === 'zoom')).toMatchObject({
      start: 6,
      end: 8,
    })
    // Fresh objects, not shared.
    expect(left?.effects?.[1]).not.toBe(right?.effects?.[1])
  })

  it('splitEffects drops a fade that has no edge left', () => {
    const { left, right } = splitEffects([createFade({ in: 0, out: 1 })])
    expect(left).toHaveLength(0)
    expect(right).toHaveLength(1)
  })

  it('cutTimeRanges never creates fade dips at cuts', () => {
    let n = 0
    const p = project([
      clip('a', { effects: [createFade({ in: 1, out: 1 })] }),
      clip('b', {
        timelineStart: 10,
        sourceOut: 10,
        effects: [createFade({ in: 1, out: 1 })],
      }),
    ])
    // Cut inside a (spans), and the tail of a into the head of b.
    const out = cutTimeRanges(
      p,
      [
        { start: 3, end: 4 },
        { start: 9, end: 11 },
      ],
      () => `n${++n}`,
    )
    const fades = out.clips
      .slice()
      .sort((x, y) => x.timelineStart - y.timelineStart)
      .map((c) => {
        const f = fadeOf(c)
        return f ? [f.in, f.out] : null
      })
    // a-left [0,3]: keeps fade-in; a-right [3,8]: none; b [8,17]: keeps fade-out.
    expect(fades).toEqual([[1, 0], null, [0, 1]])
  })
})

describe('duplicate', () => {
  it('copies effects (deep) and other clip fields', () => {
    const c = clip('c1', {
      effects: [createZoom(1, 2), createFade()] as ClipEffect[],
      color: { brightness: 1.2, contrast: 1, saturation: 1, hue: 0, blur: 0 },
    })
    const d = duplicateClipData(c, 20)
    expect(d.timelineStart).toBe(20)
    expect(d.effects).toEqual(c.effects)
    expect(d.effects?.[0]).not.toBe(c.effects?.[0])
    expect(d.color).toEqual(c.color)
    expect('id' in d).toBe(false)
  })
})

// ─── transitions own their edges ─────────────────────────────────────────────

describe('fade edges with transitions', () => {
  const a = clip('a', { sourceOut: 5, effects: [createFade({ in: 1, out: 1 })] })
  const b = clip('b', {
    timelineStart: 5,
    sourceIn: 5,
    sourceOut: 10,
    effects: [createFade({ in: 1, out: 1 })],
  })
  const p = project([a, b], {
    transitions: [
      { id: 't', fromClipId: 'a', toClipId: 'b', kind: 'crossfade', duration: 1 },
    ],
  })

  it('ignores the fade edge a transition is attached to', () => {
    expect(fadeEdges(p, 'a')).toEqual({ fadeIn: true, fadeOut: false })
    expect(fadeEdges(p, 'b')).toEqual({ fadeIn: false, fadeOut: true })
    expect(effectiveFade(p, a)).toEqual({ in: 1, out: 0 })
  })

  it('export audio plan emits a curve for the fade, honouring transitions', () => {
    const plan = planClipAudio(p, a, 10)
    expect(plan.edgeFade).toEqual({ in: 1, out: 0 })
    const curve = sampleVolumeCurve(a, plan.start, plan.stop, 10, plan.edgeFade)
    expect(curve).not.toBeNull()
    expect(curve![0]).toBe(0)
    expect(curve![5]).toBeCloseTo(0.5) // t = 0.5 s
    expect(curve![10]).toBeCloseTo(1)
    // The fade-out edge belongs to the crossfade → still full volume at 4.9 s.
    expect(curve![49]).toBeCloseTo(1)
  })

  it('no fade → no curve (constant volume)', () => {
    const plain = clip('x')
    const plan = planClipAudio(project([plain]), plain, 10)
    expect(plan.edgeFade).toBeNull()
    expect(sampleVolumeCurve(plain, 0, 10, 10, plan.edgeFade)).toBeNull()
  })

  it('fade × volume keyframes multiply', () => {
    const c = clip('k', {
      volume: 0.5,
      effects: [createFade({ in: 2, out: 0 })],
    })
    const curve = sampleVolumeCurve(c, 0, 2, 2, { in: 2, out: 0 })!
    expect(Array.from(curve)).toEqual([0, 0.125, 0.25, 0.375, 0.5])
  })
})

describe('freeZoomRange', () => {
  it('finds the gap around a time, or null inside a zoom', () => {
    const fx = [createZoom(2, 4), createZoom(8, 9)]
    expect(freeZoomRange(fx, 3)).toBeNull()
    expect(freeZoomRange(fx, 5)).toEqual({ min: 4, max: 8 })
    expect(freeZoomRange(fx, 0)).toEqual({ min: -Infinity, max: 2 })
  })
})
