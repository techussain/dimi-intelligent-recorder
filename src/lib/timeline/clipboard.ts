/**
 * Clip clipboard: copy / cut / paste of timeline clips and "Paste
 * attributes". Pure data functions; the store applies them in one undo step
 * and `clipboardEvents.ts` wires them to the DOM copy / cut / paste events.
 *
 * Payload: the copied clips (full data), the per-clip sources they own
 * (text / element / shape — cloned on paste so a copy never edits the
 * original) and where their tracks were. Media sources (video, audio,
 * images, animations) are only referenced by id: a clip whose media isn't in
 * the project it is pasted into is skipped.
 *
 * Paste placement (`pasteInto`): clips keep their times relative to the
 * earliest one, starting at the playhead, and stay together per original
 * track. Each original track's clips go to that same track when it still
 * exists, is unlocked, takes them and is free over their new time ranges;
 * otherwise to the nearest free track of the same kind above it (visual) /
 * below it (audio) that has no built-in recording role; otherwise to a new
 * track of that kind inserted right above (visual) / below (audio) it.
 */
import { z } from 'zod'
import { ClipSchema, MediaSourceSchema } from '../persistence/projectSchema'
import { cloneEffects } from '../effects/edit'
import {
  defaultZoomMode,
  effectAllowedFor,
  zoomModesFor,
  type ClipEffect,
} from '../effects/types'
import { isCroppableKind } from '../layout/placement'
import { normalizeShape } from '../shapes'
import { isSourceCompatible, isVisualTrackKind } from './compat'
import { duplicateClipData } from './duplicate'
import type {
  Clip,
  ID,
  KeyframeProp,
  MediaSource,
  Project,
  Track,
  TrackKind,
} from './types'

/** System-clipboard MIME type of a copied clip payload (JSON). */
export const CLIPS_MIME = 'application/x-dimi-clips'

export interface ClipboardTrack {
  id: ID
  kind: TrackKind
  index: number
}

export interface ClipboardPayload {
  format: 'dimi-clips'
  version: 1
  projectId: ID
  clips: Clip[]
  /** Per-clip sources (text / element / shape) of the copied clips. */
  sources: MediaSource[]
  tracks: ClipboardTrack[]
}

/** Sources owned by one clip (no media file): cloned on paste / duplicate. */
export function isPerClipSource(src: Pick<MediaSource, 'kind'>): boolean {
  return src.kind === 'text' || src.kind === 'element' || src.kind === 'shape'
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function endOf(
  c: Pick<Clip, 'timelineStart' | 'sourceIn' | 'sourceOut' | 'speed'>,
): number {
  return (
    c.timelineStart +
    Math.max(0, (c.sourceOut - c.sourceIn) / Math.max(0.1, c.speed || 1))
  )
}

/** The selected (non-live) clips of `project` as a clipboard payload, or null. */
export function buildClipboard(
  project: Project,
  ids: readonly ID[],
): ClipboardPayload | null {
  const idSet = new Set(ids)
  const clips = project.clips
    .filter((c) => idSet.has(c.id) && !c.isLive)
    .sort((a, b) => a.timelineStart - b.timelineStart)
  if (clips.length === 0) return null
  const sources: MediaSource[] = []
  const trackIds = new Set<ID>()
  for (const c of clips) {
    trackIds.add(c.trackId)
    const src = project.sources.find((s) => s.id === c.sourceId)
    if (src && isPerClipSource(src) && !sources.some((s) => s.id === src.id))
      sources.push(clone(src))
  }
  const tracks: ClipboardTrack[] = []
  project.tracks.forEach((t, index) => {
    if (trackIds.has(t.id)) tracks.push({ id: t.id, kind: t.kind, index })
  })
  return {
    format: 'dimi-clips',
    version: 1,
    projectId: project.id,
    clips: clone(clips),
    sources,
    tracks,
  }
}

const PayloadSchema = z.object({
  format: z.literal('dimi-clips'),
  version: z.literal(1),
  projectId: z.string(),
  clips: z.array(ClipSchema).min(1),
  sources: z.array(MediaSourceSchema),
  tracks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['video', 'audio', 'overlay', 'text']),
      index: z.number(),
    }),
  ),
})

/** Parse a payload read from the system clipboard (null when invalid). */
export function parseClipboard(text: string): ClipboardPayload | null {
  try {
    const r = PayloadSchema.safeParse(JSON.parse(text))
    return r.success ? (r.data as ClipboardPayload) : null
  } catch {
    return null
  }
}

/** Human-readable fallback written as text/plain. */
export function clipboardText(payload: ClipboardPayload, project: Project): string {
  const lines = payload.clips.map((c) => {
    const src =
      payload.sources.find((s) => s.id === c.sourceId) ??
      project.sources.find((s) => s.id === c.sourceId)
    const name = src?.name ?? 'Clip'
    const kind = src?.kind ?? 'clip'
    return `${name} (${kind}) ${c.timelineStart.toFixed(2)}s–${endOf(c).toFixed(2)}s`
  })
  const n = payload.clips.length
  return [
    `${String(n)} clip${n === 1 ? '' : 's'} from Dimi Intelligent Recorder`,
    ...lines,
  ].join('\n')
}

/** The source a payload clip uses: its own copy (per-clip) or the project's. */
function payloadSource(
  project: Project,
  payload: ClipboardPayload,
  sourceId: ID,
): MediaSource | undefined {
  return (
    payload.sources.find((s) => s.id === sourceId) ??
    project.sources.find((s) => s.id === sourceId && !isPerClipSource(s))
  )
}

function newTrack(kind: TrackKind, id: ID): Track {
  const names: Record<TrackKind, string> = {
    video: 'Video',
    overlay: 'Overlay',
    audio: 'Audio',
    text: 'Text',
  }
  return {
    id,
    kind,
    name: names[kind],
    muted: false,
    locked: false,
    height: kind === 'video' ? 72 : kind === 'audio' ? 48 : 56,
  }
}

/**
 * Paste `payload` into `project` at time `at` (see the placement rules in
 * the header). Mutates `project` (an Immer draft in the store) and returns
 * the new clip ids plus how many clips were skipped (missing media).
 */
export function pasteInto(
  project: Project,
  payload: ClipboardPayload,
  at: number,
  makeId: () => ID,
): { ids: ID[]; skipped: number } {
  const minStart = Math.min(...payload.clips.map((c) => c.timelineStart))
  const start = Math.max(0, at)
  let skipped = 0
  // Clips per original track, in the original top-to-bottom order.
  const groups = new Map<ID, { clip: Clip; source: MediaSource }[]>()
  for (const c of payload.clips) {
    const source = payloadSource(project, payload, c.sourceId)
    if (!source) {
      skipped++
      continue
    }
    const list = groups.get(c.trackId) ?? []
    list.push({ clip: c, source })
    groups.set(c.trackId, list)
  }
  const trackInfo = new Map(payload.tracks.map((t) => [t.id, t]))
  const order = [...groups.keys()].sort(
    (a, b) => (trackInfo.get(a)?.index ?? 0) - (trackInfo.get(b)?.index ?? 0),
  )
  const ids: ID[] = []
  const linkMap = new Map<ID, ID>()
  const linkCounts = new Map<ID, number>()
  for (const c of payload.clips)
    if (c.linkGroup) linkCounts.set(c.linkGroup, (linkCounts.get(c.linkGroup) ?? 0) + 1)
  const now = Date.now()

  for (const origTrackId of order) {
    const items = groups.get(origTrackId) ?? []
    const ranges = items.map(({ clip }) => {
      const s = start + (clip.timelineStart - minStart)
      return { s, e: s + (endOf(clip) - clip.timelineStart) }
    })
    const audio = items.every(({ source }) => source.kind === 'audio')
    const origIdx = project.tracks.findIndex((t) => t.id === origTrackId)
    const orig = project.tracks[origIdx]
    const kind: TrackKind =
      orig?.kind ?? trackInfo.get(origTrackId)?.kind ?? (audio ? 'audio' : 'overlay')
    const takes = (t: Track) =>
      !t.locked &&
      items.every(({ source }) => isSourceCompatible(t.kind, source.kind)) &&
      ranges.every(
        (r) =>
          !project.clips.some(
            (c) => c.trackId === t.id && r.s < endOf(c) && r.e > c.timelineStart,
          ),
      )
    let target: Track | undefined = orig && takes(orig) ? orig : undefined
    if (!target) {
      const fallback = (t: Track | undefined): t is Track =>
        !!t && t.kind === kind && !t.role && takes(t)
      if (origIdx < 0) {
        target = project.tracks.find((t) => fallback(t))
      } else if (!audio) {
        for (let i = origIdx - 1; i >= 0 && !target; i--) {
          const t = project.tracks[i]
          if (fallback(t)) target = t
        }
      } else {
        for (let i = origIdx + 1; i < project.tracks.length && !target; i++) {
          const t = project.tracks[i]
          if (fallback(t)) target = t
        }
      }
    }
    if (!target) {
      // A kind that can't take these clips (e.g. a 'text' track): overlay.
      const fits = items.every(({ source }) => isSourceCompatible(kind, source.kind))
      const k: TrackKind = fits ? kind : audio ? 'audio' : 'overlay'
      target = newTrack(k, makeId())
      if (origIdx < 0) {
        if (audio) project.tracks.push(target)
        else project.tracks.unshift(target)
      } else {
        project.tracks.splice(audio ? origIdx + 1 : origIdx, 0, target)
      }
    }
    const trackId = target.id
    items.forEach(({ clip, source }, i) => {
      let sourceId = source.id
      if (isPerClipSource(source)) {
        sourceId = makeId()
        project.sources.push({ ...clone(source), id: sourceId, createdAt: now })
      }
      const id = makeId()
      const data = clone(duplicateClipData(clip, ranges[i]?.s ?? start))
      const pasted: Clip = { id, ...data, trackId, sourceId }
      if (clip.linkGroup && (linkCounts.get(clip.linkGroup) ?? 0) > 1) {
        let g = linkMap.get(clip.linkGroup)
        if (!g) {
          g = makeId()
          linkMap.set(clip.linkGroup, g)
        }
        pasted.linkGroup = g
      }
      project.clips.push(pasted)
      ids.push(id)
    })
  }
  return { ids, skipped }
}

// ── Paste attributes ────────────────────────────────────────────────────────

export type AttributeKey =
  | 'transform'
  | 'crop'
  | 'opacity'
  | 'effects'
  | 'color'
  | 'textStyle'
  | 'shapeStyle'

export const ATTRIBUTE_KEYS: readonly AttributeKey[] = [
  'transform',
  'crop',
  'opacity',
  'effects',
  'color',
  'textStyle',
  'shapeStyle',
]

export const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  transform: 'Transform (position, scale, rotation, anchor, flip)',
  crop: 'Crop',
  opacity: 'Opacity & blend mode',
  effects: 'Effects',
  color: 'Color adjustments',
  textStyle: 'Text style',
  shapeStyle: 'Shape style',
}

export type AttributeSelection = Record<AttributeKey, boolean>

export interface AttributeSource {
  clip: Clip
  source: MediaSource | undefined
}

/** The copied clip "Paste attributes" reads from: the payload's first clip. */
export function attributeSource(
  project: Project,
  payload: ClipboardPayload,
): AttributeSource | null {
  const clip = payload.clips[0]
  if (!clip) return null
  return { clip, source: payloadSource(project, payload, clip.sourceId) }
}

/**
 * Which attributes make sense from `from` to `targets`: crop needs a
 * cropped picture copied and a croppable target, text style text → text,
 * shape style shape → shape; effects and colour only when the copied clip
 * has some (so pasting never silently strips them); transform and opacity
 * apply to any visual clip.
 */
export function applicableAttributes(
  from: AttributeSource,
  targets: readonly { clip: Clip; source: MediaSource | undefined }[],
): AttributeSelection {
  const fromKind = from.source?.kind
  const visual =
    fromKind !== undefined &&
    fromKind !== 'audio' &&
    targets.some((t) => !!t.source && t.source.kind !== 'audio')
  return {
    transform: visual,
    opacity: visual,
    color: visual && !!from.clip.color,
    effects: targets.length > 0 && (from.clip.effects?.length ?? 0) > 0,
    crop:
      !!fromKind &&
      isCroppableKind(fromKind) &&
      !!from.clip.crop &&
      targets.some((t) => !!t.source && isCroppableKind(t.source.kind)),
    textStyle:
      fromKind === 'text' &&
      !!from.source?.text &&
      targets.some((t) => t.source?.kind === 'text'),
    shapeStyle:
      fromKind === 'shape' &&
      !!from.source?.shape &&
      targets.some((t) => t.source?.kind === 'shape'),
  }
}

const TRANSFORM_PROPS = ['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const

function copyKeyframes(target: Clip, from: Clip, props: readonly KeyframeProp[]): void {
  for (const p of props) {
    const list = from.keyframes?.[p]
    if (list && list.length) {
      target.keyframes ??= {}
      target.keyframes[p] = list.map((k) => ({ ...k }))
    } else if (target.keyframes?.[p]) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete target.keyframes[p]
    }
  }
  if (target.keyframes && Object.keys(target.keyframes).length === 0)
    delete target.keyframes
}

/** Effects of `from` that a clip of `kind` can take (zoom modes adjusted). */
function effectsFor(
  from: readonly ClipEffect[],
  kind: MediaSource['kind'],
): ClipEffect[] {
  return cloneEffects(from)
    .filter((e) => effectAllowedFor(e.type, kind))
    .map((e) =>
      e.type === 'zoom' && !zoomModesFor(kind).includes(e.mode)
        ? { ...e, mode: defaultZoomMode(kind, true) }
        : e,
    )
}

/**
 * Apply the selected attributes of `from` to the clips `targetIds` (live
 * clips and the source clip itself are skipped). Mutates `project` (an
 * Immer draft in the store). Returns how many clips were targeted.
 */
export function pasteAttributesInto(
  project: Project,
  from: AttributeSource,
  sel: AttributeSelection,
  targetIds: readonly ID[],
): number {
  const f = from.clip
  const fromSrc = from.source
  let count = 0
  for (const id of targetIds) {
    const c = project.clips.find((x) => x.id === id)
    if (!c || c.isLive || c.id === f.id) continue
    const src = project.sources.find((s) => s.id === c.sourceId)
    const track = project.tracks.find((t) => t.id === c.trackId)
    const visual = !!track && isVisualTrackKind(track.kind) && src?.kind !== 'audio'
    count++
    if (sel.transform && visual) {
      for (const p of TRANSFORM_PROPS) c.transform[p] = f.transform[p]
      if (f.transform.anchorX === undefined) delete c.transform.anchorX
      else c.transform.anchorX = f.transform.anchorX
      if (f.transform.anchorY === undefined) delete c.transform.anchorY
      else c.transform.anchorY = f.transform.anchorY
      if (f.transform.lockAspect === undefined) delete c.transform.lockAspect
      else c.transform.lockAspect = f.transform.lockAspect
      copyKeyframes(c, f, TRANSFORM_PROPS)
    }
    if (
      sel.crop &&
      src &&
      isCroppableKind(src.kind) &&
      fromSrc &&
      isCroppableKind(fromSrc.kind)
    ) {
      if (f.crop) c.crop = { ...f.crop }
      else delete c.crop
    }
    if (sel.opacity && visual) {
      c.transform.opacity = f.transform.opacity
      copyKeyframes(c, f, ['opacity'])
      if (f.blendMode && f.blendMode !== 'normal') c.blendMode = f.blendMode
      else delete c.blendMode
    }
    if (sel.effects && src) {
      const fx = effectsFor(f.effects ?? [], src.kind)
      if (fx.length) c.effects = fx
      else delete c.effects
    }
    if (sel.color && visual) {
      if (f.color) c.color = { ...f.color }
      else delete c.color
    }
    if (sel.textStyle && src?.kind === 'text' && src.text && fromSrc?.text) {
      src.text = { ...clone(fromSrc.text), content: src.text.content }
    }
    if (sel.shapeStyle && src?.kind === 'shape' && src.shape && fromSrc?.shape) {
      const s = fromSrc.shape
      src.shape = normalizeShape({
        ...src.shape,
        fill: s.fill,
        stroke: s.stroke,
        strokeWidth: s.strokeWidth,
        radius: s.radius,
      })
    }
  }
  return count
}
