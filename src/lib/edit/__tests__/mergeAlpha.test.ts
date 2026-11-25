import { describe, it, expect, vi } from 'vitest'
import { mergeKeepsAlpha, planMerge } from '../mergeClips'
import type { Clip, MediaSource, Project, Track } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

const track = (id: string, kind: Track['kind']): Track => ({
  id,
  kind,
  name: id,
  muted: false,
  locked: false,
  height: 40,
})
const src = (id: string, hasAlpha?: boolean): MediaSource => ({
  id,
  kind: 'video',
  opfsPath: id,
  mimeType: 'video/webm',
  duration: 5,
  createdAt: 0,
  name: id,
  ...(hasAlpha ? { hasAlpha } : {}),
})
const clip = (id: string, trackId: string, sourceId: string): Clip => ({
  id,
  trackId,
  sourceId,
  timelineStart: 0,
  sourceIn: 0,
  sourceOut: 5,
  speed: 1,
  transform: { ...identityTransform },
  volume: 1,
})

function project(clips: Clip[], sources: MediaSource[]): Project {
  return {
    id: 'p',
    name: 'p',
    fps: 30,
    width: 1280,
    height: 720,
    sampleRate: 48000,
    tracks: [track('ov', 'overlay'), track('v1', 'video')],
    clips,
    transitions: [],
    sources,
    duration: 5,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('mergeKeepsAlpha', () => {
  const sources = [src('plain'), src('alpha', true)]
  it('keeps alpha when a merged overlay-track clip has an alpha source', () => {
    const p = project([clip('a', 'ov', 'alpha'), clip('b', 'v1', 'plain')], sources)
    expect(mergeKeepsAlpha(p, planMerge(p, ['a', 'b']))).toBe(true)
  })
  it('does not when the alpha source sits on the base video track', () => {
    const p = project([clip('a', 'ov', 'plain'), clip('b', 'v1', 'alpha')], sources)
    expect(mergeKeepsAlpha(p, planMerge(p, ['a', 'b']))).toBe(false)
  })
  it('does not when no merged source has alpha', () => {
    const p = project([clip('a', 'ov', 'plain'), clip('b', 'v1', 'plain')], sources)
    expect(mergeKeepsAlpha(p, planMerge(p, ['a', 'b']))).toBe(false)
  })
})

describe('overlay-only merges', () => {
  it('keep transparency when no merged clip is on a base video track', () => {
    const p = project(
      [clip('a', 'ov', 'plain'), { ...clip('b', 'ov', 'plain'), timelineStart: 5 }],
      [src('plain')],
    )
    expect(mergeKeepsAlpha(p, planMerge(p, ['a', 'b']))).toBe(true)
  })

  it('a full-frame merged picture fills the frame on an overlay track', async () => {
    const { visualBox } = await import('../../layout/geometry')
    const merged: MediaSource = {
      ...src('m'),
      width: 1280,
      height: 720,
      fullFrame: true,
    }
    const box = visualBox({ width: 1280, height: 720 }, { kind: 'overlay' }, merged, {
      ...identityTransform,
    })!
    expect([box.centerX, box.centerY, box.width, box.height]).toEqual([
      640, 360, 1280, 720,
    ])
    // Without the flag, overlay media is the bottom-right picture-in-picture.
    const pip = visualBox({ width: 1280, height: 720 }, { kind: 'overlay' }, src('m'), {
      ...identityTransform,
    })!
    expect(pip.width).toBeCloseTo(320)
  })
})
