/**
 * Project schema parse() validation.
 *
 * Verifies that parse() throws for bad inputs and succeeds for valid ones.
 * Also tests that prototype-pollution via __proto__ is not possible.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parse,
  serialize,
  IRPROJ_VERSION,
  saveCurrentProject,
  saveStoredProject,
  deleteStoredProject,
  loadStoredProject,
  loadCurrentProject,
  listRecent,
} from '../project'
import type { Project } from '../../timeline/types'

// jsdom has no IndexedDB: back idb-keyval with an in-memory map. Plain
// functions (not vi.fn) so restoreMocks never strips the implementations.
const idb = vi.hoisted(() => new Map<unknown, unknown>())
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: (k: unknown) => Promise.resolve(idb.get(k)),
  getMany: (ks: unknown[]) => Promise.resolve(ks.map((k) => idb.get(k))),
  set: (k: unknown, v: unknown) => Promise.resolve(void idb.set(k, v)),
  setMany: (es: [unknown, unknown][]) =>
    Promise.resolve().then(() => {
      for (const [k, v] of es) idb.set(k, v)
    }),
  del: (k: unknown) => Promise.resolve(void idb.delete(k)),
  keys: () => Promise.resolve([...idb.keys()]),
}))

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeProject(): Project {
  const now = 1_000_000
  return {
    id: 'test-id',
    name: 'Test Project',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [],
    clips: [],
    transitions: [],
    sources: [],
    duration: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/** Wrap a project value in a valid IrprojFile JSON string. */
function wrap(
  project: unknown,
  opts: { format?: string; version?: number } = {},
): string {
  return JSON.stringify({
    format: opts.format ?? 'irproj',
    version: opts.version ?? IRPROJ_VERSION,
    project,
  })
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('parse()', () => {
  it('throws for missing format field', () => {
    const raw = JSON.stringify({ version: IRPROJ_VERSION, project: makeProject() })
    expect(() => parse(raw)).toThrow('Not an .irproj file')
  })

  it('throws for wrong format value', () => {
    const raw = wrap(makeProject(), { format: 'WRONG' })
    expect(() => parse(raw)).toThrow('Not an .irproj file')
  })

  it('throws for version newer than IRPROJ_VERSION', () => {
    const raw = wrap(makeProject(), { version: IRPROJ_VERSION + 1 })
    expect(() => parse(raw)).toThrow(`${IRPROJ_VERSION + 1}`)
  })

  it('throws for unknown track.kind', () => {
    const project = {
      ...makeProject(),
      tracks: [
        { id: 't1', kind: 'laser', name: 'T', muted: false, locked: false, height: 72 },
      ],
    }
    expect(() => parse(wrap(project))).toThrow()
  })

  it('throws for negative fps', () => {
    expect(() => parse(wrap({ ...makeProject(), fps: -1 }))).toThrow()
  })

  it('throws for fps = 0 (below min of 1)', () => {
    expect(() => parse(wrap({ ...makeProject(), fps: 0 }))).toThrow()
  })

  it('clamps speed = 0 to 0.1 instead of throwing', () => {
    const project = {
      ...makeProject(),
      tracks: [
        { id: 't1', kind: 'video', name: 'V', muted: false, locked: false, height: 72 },
      ],
      sources: [
        {
          id: 's1',
          kind: 'video',
          opfsPath: 'x.webm',
          mimeType: 'video/webm',
          duration: 10,
          createdAt: 0,
          name: 'x.webm',
        },
      ],
      clips: [
        {
          id: 'c1',
          trackId: 't1',
          sourceId: 's1',
          timelineStart: 0,
          sourceIn: 0,
          sourceOut: 10,
          speed: 0,
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
          volume: 1,
        },
      ],
    }
    const result = parse(wrap(project))
    expect(result.clips[0]?.speed).toBe(0.1)
  })

  it('clamps speed = 100 to 16 (max speed)', () => {
    const project = {
      ...makeProject(),
      tracks: [
        { id: 't1', kind: 'video', name: 'V', muted: false, locked: false, height: 72 },
      ],
      sources: [
        {
          id: 's1',
          kind: 'video',
          opfsPath: 'x.webm',
          mimeType: 'video/webm',
          duration: 10,
          createdAt: 0,
          name: 'x.webm',
        },
      ],
      clips: [
        {
          id: 'c1',
          trackId: 't1',
          sourceId: 's1',
          timelineStart: 0,
          sourceIn: 0,
          sourceOut: 10,
          speed: 100,
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
          volume: 1,
        },
      ],
    }
    const result = parse(wrap(project))
    expect(result.clips[0]?.speed).toBe(16)
  })

  it('ignores __proto__ key and does not pollute Object.prototype', () => {
    // Craft a JSON string that contains __proto__ as a literal key.
    // JSON.parse treats it as an own property — Zod strips unknown keys.
    const raw = `{"format":"irproj","version":${IRPROJ_VERSION},"project":{"id":"p1","name":"Test","fps":30,"width":1920,"height":1080,"sampleRate":48000,"tracks":[],"clips":[],"transitions":[],"sources":[],"duration":0,"createdAt":0,"updatedAt":0,"__proto__":{"admin":true}}}`
    const result = parse(raw)
    // Parse should succeed (valid fields present) with the extra key stripped
    expect(result.id).toBe('p1')
    // Prototype must NOT be polluted
    expect((Object.prototype as Record<string, unknown>)['admin']).toBeUndefined()
  })

  it('parses a round-tripped defaultProject() successfully', () => {
    const project = makeProject()
    const raw = serialize(project)
    const result = parse(raw)
    expect(result.id).toBe(project.id)
    expect(result.fps).toBe(30)
    expect(result.tracks).toHaveLength(0)
    expect(result.clips).toHaveLength(0)
  })

  it('round-trips a clip that keyframes only SOME props (regression: exhaustive z.record)', () => {
    // A clip typically animates one or two props, not all seven. Before the
    // `z.partialRecord` fix, Zod v4 required every KeyframeProp key to be
    // present and threw "expected array, received undefined" for the absent
    // ones — making every keyframed project unopenable.
    const project = {
      ...makeProject(),
      tracks: [
        { id: 't1', kind: 'video', name: 'V', muted: false, locked: false, height: 72 },
      ],
      sources: [
        {
          id: 's1',
          kind: 'video',
          opfsPath: 'x.webm',
          mimeType: 'video/webm',
          duration: 10,
          createdAt: 0,
          name: 'x.webm',
        },
      ],
      clips: [
        {
          id: 'c1',
          trackId: 't1',
          sourceId: 's1',
          timelineStart: 0,
          sourceIn: 0,
          sourceOut: 10,
          speed: 1,
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
          volume: 1,
          keyframes: {
            opacity: [
              { t: 0, value: 0 },
              { t: 1, value: 1 },
            ],
          },
        },
      ],
    }
    const result = parse(wrap(project))
    expect(result.clips[0]?.keyframes?.opacity).toHaveLength(2)
    // Props the user never animated must stay absent, not be coerced to [].
    expect(result.clips[0]?.keyframes?.volume).toBeUndefined()
  })
})

describe('parse() repairs user-editable values instead of rejecting the file', () => {
  const withClip = (clip: Record<string, unknown>) => ({
    ...makeProject(),
    tracks: [
      { id: 't1', kind: 'video', name: 'V', muted: false, locked: false, height: 72 },
    ],
    sources: [
      {
        id: 's1',
        kind: 'video',
        opfsPath: 'x.webm',
        mimeType: 'video/webm',
        duration: 10,
        createdAt: 0,
        name: 'x.webm',
      },
    ],
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        sourceId: 's1',
        timelineStart: 0,
        sourceIn: 0,
        sourceOut: 10,
        speed: 1,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
        volume: 1,
        ...clip,
      },
    ],
  })

  it('opens a project whose name was cleared', () => {
    expect(parse(wrap({ ...makeProject(), name: '' })).name).toBe('Untitled Project')
  })

  it('clamps out-of-range opacity / volume', () => {
    const r = parse(
      wrap(
        withClip({
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1.5 },
          volume: 9,
        }),
      ),
    )
    expect(r.clips[0]?.transform.opacity).toBe(1)
    expect(r.clips[0]?.volume).toBe(4)
  })

  it('replaces null numbers (serialized NaN/Infinity) with defaults', () => {
    const p = withClip({
      transform: { x: null, y: 0, scaleX: null, scaleY: 1, rotation: 0, opacity: 1 },
    })
    // JSON.stringify writes NaN/Infinity as null — simulate that round trip.
    const r = parse(
      JSON.stringify({ format: 'irproj', version: IRPROJ_VERSION, project: p }),
    )
    expect(r.clips[0]?.transform.x).toBe(0)
    expect(r.clips[0]?.transform.scaleX).toBe(1)
  })

  it('treats an Infinity source duration (null) as 0 rather than failing', () => {
    const p = withClip({})
    ;(p.sources[0] as Record<string, unknown>)['duration'] = null
    expect(parse(wrap(p)).sources[0]?.duration).toBe(0)
  })
})

describe('autosave slots', () => {
  beforeEach(() => {
    idb.clear()
  })

  it('saveStoredProject writes the slot without changing the last-open project', async () => {
    const a = { ...makeProject(), id: 'a' }
    const b = { ...makeProject(), id: 'b', name: 'B' }
    await saveCurrentProject(a)
    await saveStoredProject(b)
    expect((await loadCurrentProject())?.id).toBe('a')
    expect((await loadStoredProject('b'))?.name).toBe('B')
  })

  it('deleteStoredProject removes the slot, recent entry and last-open pointer', async () => {
    const a = { ...makeProject(), id: 'a' }
    const b = { ...makeProject(), id: 'b' }
    await saveStoredProject(b)
    await saveCurrentProject(a)
    await deleteStoredProject('a')
    expect(await loadStoredProject('a')).toBeNull()
    expect(await loadCurrentProject()).toBeNull()
    expect((await listRecent()).map((e) => e.id)).toEqual(['b'])
    await deleteStoredProject('b')
    expect(await listRecent()).toEqual([])
  })
})

describe('importKey', () => {
  it('survives a save/open round trip (import dedup across sessions)', () => {
    const project = {
      ...makeProject(),
      sources: [
        {
          id: 's1',
          kind: 'video',
          opfsPath: 'imports/s1.mp4',
          mimeType: 'video/mp4',
          duration: 3,
          createdAt: 0,
          name: 'clip.mp4',
          importKey: 'clip.mp4|1234|99',
        },
      ],
    }
    expect(parse(wrap(project)).sources[0]?.importKey).toBe('clip.mp4|1234|99')
  })
})

describe('project-level numbers', () => {
  it('falls back to defaults for null fps / size / sample rate instead of rejecting', () => {
    const p = {
      ...makeProject(),
      fps: null,
      width: null,
      height: null,
      sampleRate: null,
    }
    const r = parse(wrap(p))
    expect([r.fps, r.width, r.height, r.sampleRate]).toEqual([30, 1920, 1080, 48000])
  })
})
