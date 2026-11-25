import { describe, expect, it } from 'vitest'
import { sampleEffects, sampleZoom } from '../sample'
import { createZoom, defaultZoomMode, normalizeEffect, zoomModesFor } from '../types'
import { parse } from '../../persistence/project'
import type { Clip, Project } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

const clip = (effects: NonNullable<Clip['effects']>): Clip => ({
  id: 'c',
  trackId: 't',
  sourceId: 's',
  timelineStart: 0,
  sourceIn: 0,
  sourceOut: 10,
  speed: 1,
  volume: 1,
  transform: { ...identityTransform },
  effects,
})

describe('zoom modes', () => {
  it("'inside' zooms feed the crop; 'grow' and 'frame' don't", () => {
    const inside = sampleEffects(
      clip([createZoom(1, 5, { easeIn: 0, easeOut: 0 })]),
      3,
      3,
    )
    expect(inside.crop.scale).toBe(2)
    expect(inside.grow).toBeNull()
    expect(inside.frame).toBeNull()

    const grow = sampleEffects(
      clip([createZoom(1, 5, { mode: 'grow', focusX: 0.2, easeIn: 0, easeOut: 0 })]),
      3,
      3,
    )
    expect(grow.crop.scale).toBe(1)
    expect(grow.grow).toEqual({ scale: 2, fx: 0.2, fy: 0.5 })
    expect(grow.frame).toBeNull()

    const frame = sampleEffects(
      clip([createZoom(1, 5, { mode: 'frame', scale: 3, easeIn: 0, easeOut: 0 })]),
      3,
      3,
    )
    expect(frame.crop.scale).toBe(1)
    expect(frame.frame?.scale).toBe(3)
    expect(frame.grow).toBeNull()
  })

  it('eases grow zooms in and out like inside zooms', () => {
    const fx = (t: number) =>
      sampleEffects(
        clip([createZoom(1, 5, { mode: 'grow', easeIn: 1, easeOut: 1 })]),
        t,
        t,
      )
    expect(fx(0.5).grow).toBeNull() // before the zoom
    const ramp = fx(1.5).grow?.scale ?? 0
    expect(ramp).toBeGreaterThan(1)
    expect(ramp).toBeLessThan(2)
    expect(fx(3).grow?.scale).toBe(2)
    expect(fx(6).grow).toBeNull() // after
  })

  it('adjacent zooms only pan into each other when they share a mode', () => {
    const a = createZoom(1, 3, { focusX: 0.2, easeIn: 0, easeOut: 0.5 })
    const sameMode = createZoom(3, 6, { focusX: 0.8, easeIn: 1, easeOut: 0 })
    const otherMode = createZoom(3, 6, {
      mode: 'grow',
      focusX: 0.8,
      easeIn: 1,
      easeOut: 0,
    })
    // Same mode: at the start of the second segment we're still fully zoomed
    // (panning from a's focus), not zoomed out.
    expect(sampleZoom([a, sameMode], 3.01)?.scale).toBeCloseTo(2, 1)
    // Different modes: the second zoom ramps up from 1×.
    const z = sampleZoom([a, otherMode], 3.01)
    expect(z?.mode).toBe('grow')
    expect(z?.scale).toBeLessThan(1.1)
  })

  it('offers modes per source kind and picks a sensible default', () => {
    expect(zoomModesFor('video')).toEqual(['inside', 'grow', 'frame'])
    expect(zoomModesFor('text')).toEqual(['grow', 'frame'])
    expect(zoomModesFor('element')).toEqual(['grow', 'frame'])
    expect(zoomModesFor('audio')).toEqual([])
    expect(defaultZoomMode('video', false)).toBe('inside')
    expect(defaultZoomMode('video', true)).toBe('grow')
    expect(defaultZoomMode('element', false)).toBe('grow')
  })

  it('normalizes an invalid mode to inside', () => {
    const z = normalizeEffect({ ...createZoom(1, 2), mode: 'bogus' as never })
    expect(z.mode).toBe('inside')
  })

  it('projects saved before zoom modes open with inside zooms', () => {
    const project: Project = {
      id: 'p',
      name: 'P',
      fps: 30,
      width: 1920,
      height: 1080,
      sampleRate: 48000,
      tracks: [
        { id: 't', kind: 'video', name: 'V', muted: false, locked: false, height: 72 },
      ],
      clips: [clip([])],
      transitions: [],
      sources: [
        {
          id: 's',
          kind: 'video',
          opfsPath: 'x.webm',
          mimeType: 'video/webm',
          duration: 10,
          createdAt: 0,
          name: 'x',
        },
      ],
      duration: 10,
      createdAt: 0,
      updatedAt: 0,
    }
    const legacyZoom = {
      id: 'z1',
      type: 'zoom',
      enabled: true,
      start: 1,
      end: 3,
      scale: 2,
      focusX: 0.5,
      focusY: 0.5,
      easeIn: 0.5,
      easeOut: 0.5,
    }
    const raw = JSON.stringify({
      format: 'irproj',
      version: 2,
      project: { ...project, clips: [{ ...clip([]), effects: [legacyZoom] }] },
    })
    const loaded = parse(raw)
    const z = loaded.clips[0]?.effects?.[0]
    expect(z?.type).toBe('zoom')
    expect(z && 'mode' in z ? z.mode : null).toBe('inside')
  })
})
