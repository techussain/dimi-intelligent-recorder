/**
 * Shared preview/export scene logic: active-clip rule, source-time clamping,
 * transition parts, decoder keys, geometry, and export sizing/audio plans.
 */
import { describe, it, expect } from 'vitest'
import {
  baseBox,
  buildScene,
  clipSourceTime,
  colorFilter,
  findActiveClip,
  fitView,
  transitionParts,
  transitionProgress,
} from '../scene'
import { fitExportSize } from '../../export/size'
import { planClipAudio, sampleVolumeCurve } from '../../export/audioPlan'
import type {
  Clip,
  MediaSource,
  Project,
  Track,
  Transition,
} from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

// ─── helpers ─────────────────────────────────────────────────────────────────

function clip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId: 'v1',
    sourceId: 's1',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 5,
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
    opfsPath: id,
    mimeType: 'video/webm',
    duration: 10,
    createdAt: 0,
    name: id,
  }
}

function track(
  id: string,
  kind: Track['kind'] = 'video',
  over: Partial<Track> = {},
): Track {
  return { id, kind, name: id, muted: false, locked: false, height: 40, ...over }
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'p',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    // UI order: top track first.
    tracks: [track('ov', 'overlay'), track('v1')],
    clips: [],
    transitions: [],
    sources: [source('s1'), source('s2'), source('s3')],
    duration: 10,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function tr(
  from: string,
  to: string,
  kind: Transition['kind'],
  duration = 1,
): Transition {
  return { id: `${from}-${to}`, fromClipId: from, toClipId: to, kind, duration }
}

// ─── active clip ─────────────────────────────────────────────────────────────

describe('findActiveClip', () => {
  it('picks the clip with the highest timelineStart', () => {
    const clips = [clip('a', { timelineStart: 3 }), clip('b', { timelineStart: 0 })]
    expect(findActiveClip(clips, 'v1', 4)?.id).toBe('a')
  })

  it('breaks ties by array order (later wins)', () => {
    const clips = [clip('a'), clip('b')]
    expect(findActiveClip(clips, 'v1', 1)?.id).toBe('b')
  })

  it('end is exclusive, except for live clips at the live edge', () => {
    expect(findActiveClip([clip('a')], 'v1', 5)).toBeUndefined()
    expect(findActiveClip([clip('a', { isLive: true })], 'v1', 5)?.id).toBe('a')
  })

  it('can exclude live clips', () => {
    const clips = [clip('a'), clip('b', { timelineStart: 1, isLive: true })]
    expect(findActiveClip(clips, 'v1', 2, false)?.id).toBe('a')
  })
})

describe('clipSourceTime', () => {
  it('maps timeline time through speed and sourceIn', () => {
    const c = clip('a', { timelineStart: 2, sourceIn: 1, sourceOut: 9, speed: 2 })
    expect(clipSourceTime(c, 3)).toEqual({ time: 3, holding: false })
  })

  it('holds the first frame before sourceIn (no trimmed-out footage)', () => {
    const c = clip('a', { timelineStart: 2, sourceIn: 1, sourceOut: 4 })
    expect(clipSourceTime(c, 1.5)).toEqual({ time: 1, holding: true })
  })

  it('holds the last frame after sourceOut', () => {
    const c = clip('a', { sourceIn: 1, sourceOut: 4 })
    const r = clipSourceTime(c, 10)
    expect(r.holding).toBe(true)
    expect(r.time).toBeCloseTo(3.999, 6)
  })
})

// ─── transitions ─────────────────────────────────────────────────────────────

describe('transitionProgress', () => {
  it('is centred on the join', () => {
    const a = clip('a', { sourceOut: 5 })
    const b = clip('b', { timelineStart: 5 })
    expect(transitionProgress(a, b, 1, 4.4)).toBeNull()
    expect(transitionProgress(a, b, 1, 4.5)).toBe(0)
    expect(transitionProgress(a, b, 1, 5)).toBeCloseTo(0.5)
    expect(transitionProgress(a, b, 1, 5.5)).toBeNull()
  })
})

describe('transitionParts', () => {
  it('crossfade keeps outgoing opaque and fades incoming in', () => {
    const { from, to } = transitionParts('crossfade', 0.5, 100, 50)
    expect(from?.alpha).toBe(1)
    expect(to?.alpha).toBe(0.5)
  })

  it('slide translates both clips; wipe clips the incoming', () => {
    const slide = transitionParts('slide-left', 0.25, 100, 50)
    expect(slide.from?.offset).toEqual({ x: 25, y: 0 })
    expect(slide.to?.offset).toEqual({ x: -75, y: 0 })
    expect(slide.to?.clipRect).toBeUndefined()
    const wipe = transitionParts('wipe-left', 0.25, 100, 50)
    expect(wipe.to?.clipRect).toEqual({ x: 0, y: 0, w: 25, h: 50 })
    expect(wipe.to?.offset).toBeUndefined()
  })

  it('dip fades A to colour, then colour to B', () => {
    const first = transitionParts('dip-black', 0.25, 100, 50)
    expect(first.to).toBeNull()
    expect(first.from?.dip).toEqual({ color: '#000000', alpha: 0.5 })
    const second = transitionParts('dip-white', 0.75, 100, 50)
    expect(second.from).toBeNull()
    expect(second.to?.dip).toEqual({ color: '#ffffff', alpha: 0.5 })
  })
})

// ─── scene ───────────────────────────────────────────────────────────────────

describe('buildScene', () => {
  it('paints bottom → top and draws only the topmost clip per track', () => {
    const p = project({
      clips: [
        clip('under', { timelineStart: 0 }),
        clip('over', { timelineStart: 1, sourceId: 's2' }),
        clip('pip', { trackId: 'ov', sourceId: 's3' }),
      ],
    })
    const scene = buildScene(p, 2, { includeLive: false })
    expect(scene.map((g) => g.track.id)).toEqual(['v1', 'ov'])
    expect(scene[0]!.layers.map((l) => l.clip.id)).toEqual(['over'])
    expect(scene[0]!.dipFullFrame).toBe(true)
    expect(scene[1]!.dipFullFrame).toBe(false)
    expect(scene[1]!.overlay).toBe(true)
  })

  it('skips hidden tracks and (optionally) live clips', () => {
    const p = project({
      tracks: [track('ov', 'overlay', { hidden: true }), track('v1')],
      clips: [clip('live', { isLive: true }), clip('pip', { trackId: 'ov' })],
    })
    expect(buildScene(p, 1, { includeLive: false })).toEqual([])
    const live = buildScene(p, 1, { includeLive: true })
    expect(live).toHaveLength(1)
    expect(live[0]!.layers[0]!.live).toBe(true)
  })

  it('draws both sides of a crossfade with clamped source times', () => {
    const p = project({
      clips: [
        clip('a', { sourceOut: 5 }),
        clip('b', { timelineStart: 5, sourceId: 's2', sourceIn: 2, sourceOut: 8 }),
      ],
      transitions: [tr('a', 'b', 'crossfade')],
    })
    const [g] = buildScene(p, 4.75, { includeLive: false })
    expect(g!.layers.map((l) => [l.clip.id, l.alpha])).toEqual([
      ['a', 1],
      ['b', 0.25],
    ])
    // Incoming clip is before its start: holds its first frame (sourceIn).
    expect(g!.layers[1]!.sourceTime).toBe(2)
    expect(g!.layers[1]!.holding).toBe(true)
  })

  it('keys decoders by clip id when a source is shown twice', () => {
    const p = project({
      clips: [
        clip('a'),
        clip('b', { trackId: 'ov' }),
        clip('c', { trackId: 'v1', sourceId: 's2', timelineStart: 20 }),
      ],
    })
    const keys = buildScene(p, 1, { includeLive: false }).flatMap((g) =>
      g.layers.map((l) => l.key),
    )
    expect(keys).toEqual(['a', 'b'])
    const single = project({ clips: [clip('a')] })
    expect(buildScene(single, 1, { includeLive: false })[0]!.layers[0]!.key).toBe('s1')
  })

  it('same-source split + crossfade gets two decoders', () => {
    const p = project({
      clips: [
        clip('a', { sourceOut: 5 }),
        clip('b', { timelineStart: 5, sourceIn: 5, sourceOut: 10 }),
      ],
      transitions: [tr('a', 'b', 'crossfade')],
    })
    const keys = buildScene(p, 5, { includeLive: false })[0]!.layers.map((l) => l.key)
    expect(keys).toEqual(['a', 'b'])
  })
})

// ─── geometry ────────────────────────────────────────────────────────────────

describe('geometry', () => {
  it('contain-fits main-track media', () => {
    expect(baseBox(1920, 1080, false, 1080, 1080)).toEqual({
      cx: 960,
      cy: 540,
      w: 1080,
      h: 1080,
    })
    expect(baseBox(1920, 1080, false, 3840, 1080)).toEqual({
      cx: 960,
      cy: 540,
      w: 1920,
      h: 540,
    })
  })

  it('pins overlays bottom-right at 25% width', () => {
    const b = baseBox(1000, 500, true, 160, 90)
    expect(b.w).toBe(250)
    expect(b.h).toBeCloseTo(140.625)
    expect(b.cx).toBe(1000 - 125 - 20)
  })

  it('scales blur with output scale', () => {
    const c = { brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 4 }
    expect(colorFilter(c, 0.5)).toBe('blur(2px)')
    expect(colorFilter(undefined, 1)).toBeNull()
  })

  it('fitView letterboxes a mismatched aspect', () => {
    const v = fitView(1920, 1080, 1080, 1080)
    expect(v.scale).toBeCloseTo(0.5625)
    expect(v.offsetX).toBe(0)
    expect(v.offsetY).toBeCloseTo((1080 - 607.5) / 2)
  })
})

describe('fitExportSize', () => {
  it('matches the preset for a same-aspect project', () => {
    expect(fitExportSize(3840, 2160, 1920, 1080)).toEqual({ width: 1920, height: 1080 })
  })

  it('keeps portrait / other aspects, matching the short side, even dims', () => {
    expect(fitExportSize(1080, 1920, 1920, 1080)).toEqual({ width: 1080, height: 1920 })
    expect(fitExportSize(1440, 1080, 1280, 720)).toEqual({ width: 960, height: 720 })
    const odd = fitExportSize(1000, 777, 1280, 720)
    expect(odd.width % 2).toBe(0)
    expect(odd.height % 2).toBe(0)
  })
})

// ─── export audio plan ───────────────────────────────────────────────────────

describe('planClipAudio', () => {
  const a = clip('a', { sourceIn: 0, sourceOut: 5 })
  const b = clip('b', { timelineStart: 5, sourceId: 's2', sourceIn: 2, sourceOut: 8 })
  const p = project({ clips: [a, b], transitions: [tr('a', 'b', 'crossfade', 1)] })

  it('centres the crossfade on an adjacent join using source handles', () => {
    const pa = planClipAudio(p, a, 10)
    expect(pa.stop).toBeCloseTo(5.5)
    expect(pa.fades).toEqual([{ t0: 4.5, v0: 1, t1: 5.5, v1: 0 }])
    const pb = planClipAudio(p, b, 10)
    expect(pb.start).toBeCloseTo(4.5)
    expect(pb.offset).toBeCloseTo(1.5)
    expect(pb.fades).toEqual([{ t0: 4.5, v0: 0, t1: 5.5, v1: 1 }])
  })

  it('without handles, each side fades over the half it can cover', () => {
    const pa = planClipAudio(p, a, 5) // no media after sourceOut
    expect(pa.stop).toBe(5)
    expect(pa.fades).toEqual([{ t0: 4.5, v0: 1, t1: 5, v1: 0 }])
    const b0 = { ...b, sourceIn: 0 }
    const pb = planClipAudio({ ...p, clips: [a, b0] }, b0, 10)
    expect(pb.start).toBe(5)
    expect(pb.fades).toEqual([{ t0: 5, v0: 0, t1: 5.5, v1: 1 }])
  })

  it('no transitions → plays exactly the clip', () => {
    const plan = planClipAudio(project({ clips: [a] }), a, 10)
    expect(plan).toEqual({ start: 0, stop: 5, offset: 0, fades: [], edgeFade: null })
  })
})

describe('sampleVolumeCurve', () => {
  it('returns null without keyframes', () => {
    expect(sampleVolumeCurve(clip('a'), 0, 5)).toBeNull()
  })

  it('uses the clip-local (undivided) axis and keyframe easing', () => {
    const c = clip('a', {
      speed: 2,
      sourceOut: 10, // 5 s on the timeline
      keyframes: {
        volume: [
          { t: 0, value: 0, easing: 'ease-in' },
          { t: 4, value: 1 },
        ],
      },
    })
    const curve = sampleVolumeCurve(c, 0, 4, 4)! // 17 points, 0.25 s apart
    expect(curve[0]).toBe(0)
    expect(curve[8]).toBeCloseTo(0.25) // t=2 → x=0.5, ease-in → 0.25
    expect(curve[16]).toBe(1) // t=4 reaches the keyframe (not t=2)
  })
})
