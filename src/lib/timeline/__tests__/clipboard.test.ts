/** Copy / cut / paste of clips and "Paste attributes" (clipboard.ts, clipboardEvents.ts). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEditor } from '../store'
import {
  ATTRIBUTE_KEYS,
  CLIPS_MIME,
  applicableAttributes,
  attributeSource,
  buildClipboard,
  clipboardText,
  parseClipboard,
  type AttributeKey,
  type AttributeSelection,
} from '../clipboard'
import {
  copySelection,
  installClipboardHandlers,
  payloadForPaste,
  setInternalClipboard,
} from '../clipboardEvents'
import type { Clip, MediaSource, Project, Track } from '../types'
import { identityTransform } from '../types'
import { createZoom } from '../../effects/types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

const st = () => useEditor.getState()

const track = (id: string, kind: Track['kind'], over: Partial<Track> = {}): Track => ({
  id,
  kind,
  name: id,
  muted: false,
  locked: false,
  height: 40,
  ...over,
})

const media = (id: string, kind: 'video' | 'audio' | 'image'): MediaSource => ({
  id,
  kind,
  opfsPath: `${id}.bin`,
  mimeType:
    kind === 'audio' ? 'audio/webm' : kind === 'image' ? 'image/png' : 'video/webm',
  duration: kind === 'image' ? 0 : 60,
  width: 1920,
  height: 1080,
  createdAt: 0,
  name: id,
})

const textSrc = (id: string, content: string): MediaSource => ({
  id,
  kind: 'text',
  opfsPath: '',
  mimeType: 'text/plain',
  duration: 4,
  createdAt: 0,
  name: content,
  text: {
    content,
    fontFamily: 'Inter',
    fontSize: 72,
    fontWeight: 700,
    color: '#ffffff',
    align: 'center',
  },
})

const shapeSrc = (id: string): MediaSource => ({
  id,
  kind: 'shape',
  opfsPath: '',
  mimeType: 'application/x-shape',
  duration: 5,
  createdAt: 0,
  name: id,
  shape: {
    type: 'rect',
    fill: '#ff0000',
    stroke: '#000000',
    strokeWidth: 0,
    radius: 10,
    width: 200,
    height: 100,
  },
})

const clip = (
  id: string,
  trackId: string,
  sourceId: string,
  start: number,
  dur = 4,
  over: Partial<Clip> = {},
): Clip => ({
  id,
  trackId,
  sourceId,
  timelineStart: start,
  sourceIn: 0,
  sourceOut: dur,
  speed: 1,
  transform: { ...identityTransform },
  volume: 1,
  ...over,
})

function load(): void {
  const project: Project = {
    id: 'p1',
    name: 'p',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      track('T', 'overlay'),
      track('W', 'overlay', { role: 'webcam' }),
      track('S', 'video', { role: 'screen' }),
      track('A', 'audio', { role: 'mic' }),
    ],
    clips: [
      clip('title', 'T', 'txt', 2),
      clip('box', 'T', 'shp', 7, 3),
      clip('scr', 'S', 'vid', 0, 20, { linkGroup: 'g' }),
      clip('mic', 'A', 'aud', 0, 20, { linkGroup: 'g' }),
    ],
    transitions: [],
    sources: [
      textSrc('txt', 'Hello'),
      shapeSrc('shp'),
      media('vid', 'video'),
      media('aud', 'audio'),
      media('img', 'image'),
    ],
    duration: 20,
    createdAt: 0,
    updatedAt: 0,
  }
  st().loadProject(project)
}

const byId = (id: string) => st().project.clips.find((c) => c.id === id)!
const src = (id: string) => st().project.sources.find((s) => s.id === id)!

describe('buildClipboard / parseClipboard', () => {
  beforeEach(load)

  it('copies clips with their per-clip sources only (media is referenced)', () => {
    const p = buildClipboard(st().project, ['scr', 'title', 'box'])!
    expect(p.clips.map((c) => c.id)).toEqual(['scr', 'title', 'box'])
    expect(p.sources.map((s) => s.id).sort()).toEqual(['shp', 'txt'])
    expect(p.tracks).toEqual([
      { id: 'T', kind: 'overlay', index: 0 },
      { id: 'S', kind: 'video', index: 2 },
    ])
    expect(parseClipboard(JSON.stringify(p))).toEqual(p)
    expect(parseClipboard('{"format":"other"}')).toBeNull()
    expect(parseClipboard('not json')).toBeNull()
    expect(clipboardText(p, st().project)).toMatch(/^3 clips/)
    expect(buildClipboard(st().project, [])).toBeNull()
  })
})

describe('pasteClips', () => {
  beforeEach(load)

  it('pastes at the playhead keeping relative times and tracks, one undo step', () => {
    const payload = buildClipboard(st().project, ['title', 'box'])!
    const past = st().past.length
    const { ids, skipped } = st().pasteClips(payload, 30)
    expect(skipped).toBe(0)
    expect(st().past.length).toBe(past + 1)
    expect(st().selection).toEqual(ids)
    const [t, b] = ids.map(byId)
    expect(t!.timelineStart).toBe(30)
    expect(b!.timelineStart).toBe(35) // 7 - 2 later, as copied
    expect(t!.trackId).toBe('T')
    expect(b!.trackId).toBe('T')
    // Per-clip sources are cloned.
    expect(t!.sourceId).not.toBe('txt')
    expect(src(t!.sourceId).text).toEqual(src('txt').text)
    expect(b!.sourceId).not.toBe('shp')
    expect(src(b!.sourceId).shape).toEqual(src('shp').shape)
    st().undo()
    expect(st().project.clips).toHaveLength(4)
    expect(st().project.sources).toHaveLength(5)
  })

  it('references media sources and moves to free tracks when the originals are busy', () => {
    const payload = buildClipboard(st().project, ['scr', 'mic', 'title'])!
    const { ids } = st().pasteClips(payload, 1)
    const pasted = ids.map(byId)
    const scr = pasted.find((c) => c.sourceId === 'vid')!
    const mic = pasted.find((c) => c.sourceId === 'aud')!
    expect(st().project.sources).toHaveLength(6) // only the text source was cloned
    // Screen track busy → a new video track right above it (never a role track).
    const tracks = st().project.tracks
    const ti = (id: string) => tracks.findIndex((t) => t.id === id)
    expect(tracks[ti(scr.trackId)]!.kind).toBe('video')
    expect(ti(scr.trackId)).toBe(ti('S') - 1)
    // Mic busy → a new audio track right below it.
    expect(tracks[ti(mic.trackId)]!.kind).toBe('audio')
    expect(ti(mic.trackId)).toBe(ti('A') + 1)
    // Title: T busy at 1..5 (title at 2) → a new overlay track above T.
    const title = pasted.find((c) => src(c.sourceId).kind === 'text')!
    expect(ti(title.trackId)).toBe(ti('T') - 1)
    // Times relative to the earliest copied clip (scr at 0).
    expect(scr.timelineStart).toBe(1)
    expect(title.timelineStart).toBe(3)
    // Link groups are remapped together.
    expect(scr.linkGroup).toBeDefined()
    expect(scr.linkGroup).toBe(mic.linkGroup)
    expect(scr.linkGroup).not.toBe('g')
  })

  it('skips clips whose media is not in the project', () => {
    const payload = buildClipboard(st().project, ['scr', 'title'])!
    st().newProject()
    const { ids, skipped } = st().pasteClips(payload, 0)
    expect(skipped).toBe(1)
    expect(ids).toHaveLength(1)
    expect(src(byId(ids[0]!).sourceId).kind).toBe('text')
  })
})

// ── DOM events ──────────────────────────────────────────────────────────────

function fakeDataTransfer(initial: Record<string, string> = {}): DataTransfer {
  const data = new Map(Object.entries(initial))
  return {
    get types() {
      return [...data.keys()]
    },
    setData: (k: string, v: string) => {
      data.set(k, v)
    },
    getData: (k: string) => data.get(k) ?? '',
  } as unknown as DataTransfer
}

function fire(
  type: 'copy' | 'cut' | 'paste',
  dt: DataTransfer | null,
  target: EventTarget = document.body,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'clipboardData', { value: dt })
  target.dispatchEvent(e)
  return e
}

describe('clipboard events', () => {
  let uninstall: () => void
  beforeEach(() => {
    load()
    setInternalClipboard(null)
    uninstall = installClipboardHandlers()
  })
  afterEach(() => uninstall())

  it('copy writes JSON + text; paste inserts at the playhead in one undo step', () => {
    st().setSelection(['title'])
    const dt = fakeDataTransfer()
    expect(fire('copy', dt).defaultPrevented).toBe(true)
    expect(parseClipboard(dt.getData(CLIPS_MIME))?.clips[0]?.id).toBe('title')
    expect(dt.getData('text/plain')).toMatch(/Hello/)
    st().setPlayhead(12)
    const past = st().past.length
    expect(fire('paste', dt).defaultPrevented).toBe(true)
    expect(st().past.length).toBe(past + 1)
    const pasted = byId(st().selection[0]!)
    expect(pasted.timelineStart).toBe(12)
    expect(pasted.sourceId).not.toBe('txt')
  })

  it('cut = copy + delete as one undo step', () => {
    st().setSelection(['title', 'box'])
    const past = st().past.length
    const dt = fakeDataTransfer()
    expect(fire('cut', dt).defaultPrevented).toBe(true)
    expect(
      st()
        .project.clips.map((c) => c.id)
        .sort(),
    ).toEqual(['mic', 'scr'])
    expect(st().past.length).toBe(past + 1)
    fire('paste', dt)
    expect(st().project.clips).toHaveLength(4)
  })

  it('leaves text fields, modals and empty selections alone', () => {
    st().setSelection(['title'])
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(fire('copy', fakeDataTransfer(), input).defaultPrevented).toBe(false)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    expect(fire('copy', fakeDataTransfer()).defaultPrevented).toBe(false)
    dialog.remove()
    input.remove()
    st().setSelection([])
    expect(fire('copy', fakeDataTransfer()).defaultPrevented).toBe(false)
  })

  it('uses the internal clipboard only while the system clipboard still holds our text', () => {
    st().setSelection(['title'])
    copySelection(null)
    expect(payloadForPaste(null)?.clips[0]?.id).toBe('title')
    expect(
      payloadForPaste(fakeDataTransfer({ 'text/plain': 'something else' })),
    ).toBeNull()
    const text = clipboardText(buildClipboard(st().project, ['title'])!, st().project)
    expect(
      payloadForPaste(fakeDataTransfer({ 'text/plain': text }))?.clips[0]?.id,
    ).toBe('title')
    // Foreign content: the paste event is not taken over.
    expect(
      fire('paste', fakeDataTransfer({ 'text/plain': 'x' })).defaultPrevented,
    ).toBe(false)
  })
})

// ── Paste attributes ────────────────────────────────────────────────────────

const none: AttributeSelection = {
  transform: false,
  crop: false,
  opacity: false,
  effects: false,
  color: false,
  textStyle: false,
  shapeStyle: false,
}

function loadForAttributes(): void {
  const zoom = createZoom(0, 2, { mode: 'inside' })
  const project: Project = {
    id: 'p2',
    name: 'p',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [track('O', 'overlay'), track('O2', 'overlay'), track('V', 'video')],
    clips: [
      clip('src', 'V', 'vid', 0, 10, {
        transform: {
          x: 10,
          y: 20,
          scaleX: -2,
          scaleY: 2,
          rotation: 30,
          opacity: 0.5,
          anchorX: 0.2,
        },
        keyframes: { x: [{ t: 0, value: 10 }], opacity: [{ t: 1, value: 0.2 }] },
        crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
        blendMode: 'multiply',
        color: { brightness: 1.2, contrast: 1, saturation: 1, hue: 0, blur: 0 },
        effects: [zoom],
      }),
      clip('img', 'O', 'img', 0, 5),
      clip('txt', 'O2', 'txt', 0, 4),
      clip('shp', 'O2', 'shp', 5, 4),
    ],
    transitions: [],
    sources: [
      media('vid', 'video'),
      media('img', 'image'),
      textSrc('txt', 'Hi'),
      shapeSrc('shp'),
    ],
    duration: 10,
    createdAt: 0,
    updatedAt: 0,
  }
  st().loadProject(project)
}

describe('paste attributes', () => {
  beforeEach(loadForAttributes)

  const from = () =>
    attributeSource(st().project, buildClipboard(st().project, ['src'])!)!

  it('applicable attributes by kind', () => {
    const t = (ids: string[]) =>
      ids.map((id) => ({ clip: byId(id), source: src(byId(id).sourceId) }))
    expect(applicableAttributes(from(), t(['img']))).toEqual({
      ...none,
      transform: true,
      crop: true,
      opacity: true,
      effects: true,
      color: true,
    })
    // Text can't be cropped.
    expect(applicableAttributes(from(), t(['txt'])).crop).toBe(false)
    const fromText = attributeSource(
      st().project,
      buildClipboard(st().project, ['txt'])!,
    )!
    expect(applicableAttributes(fromText, t(['shp'])).textStyle).toBe(false)
    expect(applicableAttributes(fromText, t(['shp', 'txt'])).textStyle).toBe(true)
    expect(applicableAttributes(fromText, t(['img'])).crop).toBe(false)
    // Nothing to paste = not offered (pasting never strips effects / colour).
    expect(applicableAttributes(fromText, t(['img'])).effects).toBe(false)
    expect(applicableAttributes(fromText, t(['img'])).color).toBe(false)
    const fromShape = attributeSource(
      st().project,
      buildClipboard(st().project, ['shp'])!,
    )!
    expect(applicableAttributes(fromShape, t(['shp'])).shapeStyle).toBe(true)
    expect(applicableAttributes(fromShape, t(['txt'])).shapeStyle).toBe(false)
  })

  // Each attribute alone changes only its own fields.
  const cases: Record<AttributeKey, (c: Clip) => void> = {
    transform: (c) => {
      expect(c.transform).toMatchObject({
        x: 10,
        y: 20,
        scaleX: -2,
        scaleY: 2,
        rotation: 30,
      })
      expect(c.transform.anchorX).toBe(0.2)
      expect(c.transform.opacity).toBe(1)
      expect(c.keyframes?.x).toEqual([{ t: 0, value: 10 }])
      expect(c.keyframes?.opacity).toBeUndefined()
    },
    crop: (c) => expect(c.crop).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0 }),
    opacity: (c) => {
      expect(c.transform.opacity).toBe(0.5)
      expect(c.blendMode).toBe('multiply')
      expect(c.keyframes?.opacity).toEqual([{ t: 1, value: 0.2 }])
      expect(c.transform.x).toBe(0)
    },
    effects: (c) => {
      expect(c.effects).toHaveLength(1)
      expect(c.effects?.[0]?.type).toBe('zoom')
    },
    color: (c) => expect(c.color?.brightness).toBe(1.2),
    textStyle: () => {},
    shapeStyle: () => {},
  }

  for (const key of ATTRIBUTE_KEYS.filter(
    (k) => k !== 'textStyle' && k !== 'shapeStyle',
  )) {
    it(`"${key}" alone`, () => {
      const past = st().past.length
      st().pasteAttributes(from(), { ...none, [key]: true }, ['img'])
      expect(st().past.length).toBe(past + 1)
      const c = byId('img')
      cases[key](c)
      // Nothing else changed.
      if (key !== 'crop') expect(c.crop).toBeUndefined()
      if (key !== 'effects') expect(c.effects).toBeUndefined()
      if (key !== 'color') expect(c.color).toBeUndefined()
      if (key !== 'opacity') expect(c.blendMode).toBeUndefined()
      if (key !== 'transform') expect(c.transform.rotation).toBe(0)
    })
  }

  it('all at once onto several clips is one undo step; zoom adapts to text', () => {
    const past = st().past.length
    const all = {
      ...none,
      transform: true,
      crop: true,
      opacity: true,
      effects: true,
      color: true,
    }
    expect(st().pasteAttributes(from(), all, ['img', 'txt'])).toBe(2)
    expect(st().past.length).toBe(past + 1)
    const t = byId('txt')
    expect(t.crop).toBeUndefined() // text is never cropped
    expect(t.effects?.[0]).toMatchObject({ type: 'zoom', mode: 'grow' })
    expect(t.transform.rotation).toBe(30)
    st().undo()
    expect(byId('img').transform.rotation).toBe(0)
    expect(byId('txt').effects).toBeUndefined()
  })

  it('text style text → text keeps the content; shape style shape → shape keeps type and size', () => {
    st().updateTextStyle('txt', { color: '#00ff00', italic: true })
    const fromText = attributeSource(
      st().project,
      buildClipboard(st().project, ['txt'])!,
    )!
    st().addTextClip('O', 20, { content: 'Other' })
    const other = st().project.clips.find((c) => c.timelineStart === 20)!
    st().pasteAttributes(fromText, { ...none, textStyle: true }, [other.id, 'shp'])
    const ot = src(other.sourceId).text!
    expect(ot.content).toBe('Other')
    expect(ot.color).toBe('#00ff00')
    expect(ot.italic).toBe(true)

    const id = st().addShapeClip('ellipse', 30)
    const target = byId(id)
    const fromShape = attributeSource(
      st().project,
      buildClipboard(st().project, ['shp'])!,
    )!
    st().pasteAttributes(fromShape, { ...none, shapeStyle: true }, [id, 'txt'])
    const s = src(target.sourceId).shape!
    expect(s.type).toBe('ellipse')
    expect(s.fill).toBe('#ff0000')
    expect(s.stroke).toBe('#000000')
    expect(s.width).toBe(320)
    expect(src('txt').text?.color).toBe('#00ff00') // untouched by shape style
  })

  it('nothing selected / nothing applicable records no undo step', () => {
    const past = st().past.length
    st().pasteAttributes(from(), none, ['img'])
    st().pasteAttributes(from(), { ...none, crop: true }, ['txt'])
    expect(st().past.length).toBe(past)
  })
})
