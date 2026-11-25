/** Shape store actions, duplication and the project round trip of shapes / blend modes. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../store'
import { parse, serialize } from '../../persistence/project'
import type { Project } from '../types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

const st = () => useEditor.getState()
const clipById = (id: string) => st().project.clips.find((c) => c.id === id)!
const sourceById = (id: string) => st().project.sources.find((s) => s.id === id)!

describe('addShapeClip', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('adds one shape source + clip at the playhead on an overlay track, one undo step, selected', () => {
    st().setPlayhead(2)
    const past = st().past.length
    const id = st().addShapeClip('rect')
    expect(st().past.length).toBe(past + 1)
    const c = clipById(id)
    expect(c.timelineStart).toBe(2)
    expect(st().selection).toEqual([id])
    const s = sourceById(c.sourceId)
    expect(s.kind).toBe('shape')
    expect(s.opfsPath).toBe('')
    expect(s.shape?.type).toBe('rect')
    const track = st().project.tracks.find((t) => t.id === c.trackId)!
    expect(track.kind).toBe('overlay')
    st().undo()
    expect(st().project.clips).toHaveLength(0)
    expect(st().project.sources).toHaveLength(0)
  })

  it('uses the topmost free overlay track, else creates one on top', () => {
    const a = st().addShapeClip('ellipse', 0)
    const b = st().addShapeClip('line', 0)
    // Built-in tracks (webcam) are skipped: each shape gets a free 'Shapes' track.
    const webcam = st().project.tracks.find((t) => t.role === 'webcam')!
    expect(clipById(a).trackId).not.toBe(webcam.id)
    expect(clipById(a).trackId).not.toBe(clipById(b).trackId)
    expect(st().project.tracks[0]!.id).toBe(clipById(b).trackId)
    expect(st().project.tracks[0]!.name).toBe('Shapes')
    // Explicit track honoured when free.
    const c = st().addShapeClip('arrow', 20, clipById(a).trackId)
    expect(clipById(c).trackId).toBe(clipById(a).trackId)
  })
})

describe('updateShape', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('patches and clamps the shape; a quick run of edits is one undo step', () => {
    const id = st().addShapeClip('rect', 0)
    const sid = clipById(id).sourceId
    const past = st().past.length
    st().updateShape(sid, { fill: '#ff0000' })
    st().updateShape(sid, { fill: '#00ff00' })
    st().updateShape(sid, { strokeWidth: -5, radius: 99999 })
    expect(st().past.length).toBe(past + 1)
    const s = sourceById(sid).shape!
    expect(s.fill).toBe('#00ff00')
    expect(s.strokeWidth).toBe(0)
    expect(s.radius).toBe(Math.min(s.width, s.height) / 2)
    st().undo()
    expect(sourceById(sid).shape!.fill).toBe('#7c3aed')
  })

  it('renames on type change and ignores non-shape sources / no-ops', () => {
    const id = st().addShapeClip('rect', 0)
    const sid = clipById(id).sourceId
    st().updateShape(sid, { type: 'ellipse' })
    expect(sourceById(sid).name).toBe('Ellipse')
    const past = st().past.length
    st().updateShape(sid, { type: 'ellipse' })
    st().updateShape('missing', { fill: '#000' })
    expect(st().past.length).toBe(past)
  })
})

describe('duplicateClip with shapes', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('clones the shape source so editing the copy leaves the original alone', () => {
    const id = st().addShapeClip('arrow', 0)
    st().setBlendMode([id], 'screen')
    const dup = st().duplicateClip(id, 10)!
    const a = clipById(id)
    const b = clipById(dup)
    expect(b.sourceId).not.toBe(a.sourceId)
    expect(b.blendMode).toBe('screen')
    expect(sourceById(b.sourceId).shape).toEqual(sourceById(a.sourceId).shape)
    st().updateShape(b.sourceId, { stroke: '#123456' })
    expect(sourceById(a.sourceId).shape!.stroke).not.toBe('#123456')
  })
})

describe('setBlendMode', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('sets and (normal) removes the blend mode as one undo step', () => {
    const a = st().addShapeClip('rect', 0)
    const b = st().addShapeClip('rect', 0)
    const past = st().past.length
    st().setBlendMode([a, b], 'multiply')
    expect(st().past.length).toBe(past + 1)
    expect(clipById(a).blendMode).toBe('multiply')
    expect(clipById(b).blendMode).toBe('multiply')
    st().setBlendMode([a], 'normal')
    expect('blendMode' in clipById(a)).toBe(false)
  })

  it('split keeps the blend mode on both halves', () => {
    const a = st().addShapeClip('rect', 0)
    st().setBlendMode([a], 'overlay')
    st().splitAt(2, undefined, [a])
    const halves = st().project.clips.filter((c) => c.sourceId === clipById(a).sourceId)
    expect(halves).toHaveLength(2)
    for (const h of halves) expect(h.blendMode).toBe('overlay')
  })
})

describe('project round trip', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('keeps shape sources and blend modes', () => {
    const id = st().addShapeClip('ellipse', 1)
    st().updateShape(clipById(id).sourceId, { fill: 'transparent', strokeWidth: 6 })
    st().setBlendMode([id], 'difference')
    const original = st().project
    const back = parse(serialize(original))
    expect(back.sources).toEqual(original.sources)
    expect(back.clips).toEqual(original.clips)
  })

  it('repairs bad shape values and unknown blend modes; old projects are unchanged', () => {
    const id = st().addShapeClip('rect', 1)
    const raw = JSON.parse(serialize(st().project)) as { project: Project }
    const src = raw.project.sources[0]!
    ;(src.shape as unknown as Record<string, unknown>).strokeWidth = null
    ;(src.shape as unknown as Record<string, unknown>).width = -10
    ;(raw.project.clips[0] as unknown as Record<string, unknown>).blendMode = 'plasma'
    const back = parse(JSON.stringify(raw))
    expect(back.sources[0]!.shape).toMatchObject({ strokeWidth: 0, width: 1 })
    expect(back.clips[0]!.id).toBe(id)
    expect(back.clips[0]!.blendMode).toBeUndefined()
    // A broken shape block is dropped, the source kept.
    ;(src as unknown as Record<string, unknown>).shape = { type: 'star' }
    const back2 = parse(JSON.stringify(raw))
    expect(back2.sources[0]!.shape).toBeUndefined()

    // A project without shapes / blend modes round-trips exactly.
    st().newProject()
    const plain = st().project
    expect(parse(serialize(plain))).toEqual(plain)
  })
})
