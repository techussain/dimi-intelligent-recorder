/** reorderClip / reorderClips: layer order by track (rules in layerOrder.ts). */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../store'
import type { Clip, MediaSource, Project, Track } from '../types'
import { identityTransform } from '../types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

const st = () => useEditor.getState()

const track = (
  id: string,
  kind: Track['kind'] = 'overlay',
  over: Partial<Track> = {},
): Track => ({
  id,
  kind,
  name: id,
  muted: false,
  locked: false,
  height: 40,
  ...over,
})

const shape = (id: string): MediaSource => ({
  id,
  kind: 'shape',
  opfsPath: '',
  mimeType: 'application/x-shape',
  duration: 5,
  createdAt: 0,
  name: id,
  shape: {
    type: 'rect',
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 0,
    radius: 0,
    width: 100,
    height: 100,
  },
})

const video: MediaSource = {
  id: 'vid',
  kind: 'video',
  opfsPath: 'v.webm',
  mimeType: 'video/webm',
  duration: 60,
  width: 1920,
  height: 1080,
  createdAt: 0,
  name: 'screen',
}

const clip = (
  id: string,
  trackId: string,
  start = 0,
  dur = 5,
  sourceId = `s-${id}`,
): Clip => ({
  id,
  trackId,
  sourceId,
  timelineStart: start,
  sourceIn: 0,
  sourceOut: dur,
  speed: 1,
  transform: { ...identityTransform },
  volume: 0,
})

function load(tracks: Track[], clips: Clip[]): void {
  const sources: MediaSource[] = clips
    .filter((c) => c.sourceId !== 'vid')
    .map((c) => shape(c.sourceId))
  sources.push(video)
  const project: Project = {
    id: 'p',
    name: 'p',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks,
    clips,
    transitions: [],
    sources,
    duration: 60,
    createdAt: 0,
    updatedAt: 0,
  }
  st().loadProject(project)
}

const trackOf = (clipId: string) =>
  st().project.clips.find((c) => c.id === clipId)!.trackId
const indexOf = (clipId: string) =>
  st().project.tracks.findIndex((t) => t.id === trackOf(clipId))
const order = () => st().project.tracks.map((t) => t.id)

describe('reorderClip', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('forward moves one step: above the nearest overlapping clip, below the next', () => {
    load(
      [track('O0'), track('O1'), track('O2'), track('O3')],
      [clip('C', 'O0'), clip('B', 'O2'), clip('A', 'O3')],
    )
    expect(st().reorderClip('A', 'forward')).toBe(1)
    expect(trackOf('A')).toBe('O1')
    // Next step: above C → a new track on top.
    expect(st().reorderClip('A', 'forward')).toBe(1)
    expect(indexOf('A')).toBe(0)
    expect(st().project.tracks[0]!.kind).toBe('overlay')
    expect(order().slice(1)).toEqual(['O0', 'O1', 'O2', 'O3'])
  })

  it('front goes above the topmost overlapping clip, reusing a free track there', () => {
    load(
      [track('top'), track('O1'), track('O2'), track('O3')],
      [clip('C', 'O1'), clip('B', 'O2'), clip('A', 'O3')],
    )
    st().reorderClip('A', 'front')
    expect(trackOf('A')).toBe('top')
  })

  it('creates a new track directly above the blocker when no free track fits', () => {
    load([track('O0'), track('O1')], [clip('B', 'O0'), clip('A', 'O1')])
    st().reorderClip('A', 'forward')
    expect(indexOf('A')).toBe(0)
    expect(order().slice(1)).toEqual(['O0', 'O1'])
  })

  it('ignores clips that do not overlap in time (nothing to move above = no-op)', () => {
    load([track('O0'), track('O1')], [clip('B', 'O0', 10, 5), clip('A', 'O1', 0, 5)])
    const past = st().past.length
    expect(st().reorderClip('A', 'forward')).toBe(0)
    expect(trackOf('A')).toBe('O1')
    expect(st().past.length).toBe(past)
  })

  it('backward / back move down; back stops just above the screen track', () => {
    load(
      [
        track('O0'),
        track('O1'),
        track('O2'),
        track('W', 'overlay', { role: 'webcam' }),
        track('S', 'video', { role: 'screen' }),
      ],
      [
        clip('A', 'O0'),
        clip('B', 'O1'),
        clip('cam', 'W'),
        clip('scr', 'S', 0, 30, 'vid'),
      ],
    )
    st().reorderClip('A', 'backward')
    expect(trackOf('A')).toBe('O2') // below B, above the webcam
    st().reorderClip('A', 'back')
    // Below the webcam (built-in tracks are never targets) but above the screen.
    const tracks = st().project.tracks
    const ia = indexOf('A')
    expect(tracks[ia]!.role).toBeUndefined()
    expect(ia).toBe(tracks.findIndex((t) => t.id === 'W') + 1)
    expect(tracks[ia + 1]!.id).toBe('S')
    expect(trackOf('scr')).toBe('S')
    // Already directly above the screen: nothing further down.
    expect(st().reorderClip('A', 'back')).toBe(0)
  })

  it('never moves a clip onto a built-in recording track', () => {
    load(
      [track('O0'), track('W', 'overlay', { role: 'webcam' }), track('O2')],
      [clip('B', 'O2'), clip('A', 'O0')],
    )
    st().reorderClip('A', 'backward')
    expect(trackOf('A')).not.toBe('W')
    expect(indexOf('A')).toBe(3)
  })

  it('keeps the track kind: a main-track picture gets a new video track', () => {
    load(
      [track('O0'), track('V2', 'video'), track('S', 'video', { role: 'screen' })],
      [clip('B', 'O0'), clip('pic', 'V2', 0, 5, 'vid')],
    )
    st().reorderClip('pic', 'forward')
    const t = st().project.tracks[indexOf('pic')]!
    expect(t.kind).toBe('video')
    expect(indexOf('pic')).toBe(0)
  })

  it('skips locked tracks and live clips', () => {
    load(
      [track('O0'), track('L', 'overlay', { locked: true }), track('O2'), track('O3')],
      [clip('C', 'O0'), clip('B', 'O3')],
    )
    // B forward: blocker C (O0); O1 (locked) / O2 are below C → new track above C.
    st().reorderClip('B', 'forward')
    expect(indexOf('B')).toBe(0)
    const live: Clip = { ...clip('live', 'O2', 20), isLive: true }
    load([track('O0'), track('O1')], [clip('X', 'O0', 20), live])
    expect(st().reorderClip('live', 'forward')).toBe(0)
  })

  it('multi-selection keeps the relative order and is one undo step', () => {
    load(
      [track('O0'), track('O1'), track('O2')],
      [clip('C', 'O0'), clip('A', 'O1'), clip('B', 'O2')],
    )
    const before = st().project
    const past = st().past.length
    expect(st().reorderClips(['B', 'A'], 'front')).toBe(2)
    expect(st().past.length).toBe(past + 1)
    expect(indexOf('A')).toBeLessThan(indexOf('B'))
    expect(indexOf('B')).toBeLessThan(indexOf('C'))
    st().undo()
    expect(st().project).toBe(before)

    // Back: both go below the bottom clip, order kept.
    load(
      [track('O0'), track('O1'), track('O2')],
      [clip('A', 'O0'), clip('B', 'O1'), clip('C', 'O2')],
    )
    st().reorderClips(['A', 'B'], 'back')
    expect(indexOf('C')).toBeLessThan(indexOf('A'))
    expect(indexOf('A')).toBeLessThan(indexOf('B'))
  })
})
