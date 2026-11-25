/**
 * Layout commands on the current selection (align, distribute, nudge) and
 * the transform tools (flip, fit / fill, reset, position presets, anchor,
 * crop, size), applied through the store's `setTransforms` so each is one
 * undo step. Align / distribute / nudge act on the selected clips visible
 * at the playhead; the transform tools on the given clips (default: the
 * selection), using their stored (un-keyframed) transform.
 */
import { create } from 'zustand'
import { useEditor, type TransformPatch } from '../timeline/store'
import type { ClipCrop, ID, Transform } from '../timeline/types'
import type { LayerDirection } from '../timeline/layerOrder'
import {
  alignDeltas,
  distributeDeltas,
  type AlignEdge,
  type AlignRelativeTo,
  type DistributeAxis,
  type LayoutDelta,
} from './align'
import {
  axisAlignedBounds,
  boxBase,
  collectActiveVisuals,
  visualBox,
  type TextMeasurer,
  type VisualOverlay,
} from './geometry'
import { canvasTextMeasurer } from './textMeasure'
import { anchorChangePatch, cropChangePatch, normalizeCrop } from './placement'
import {
  fitPatch,
  flipPatch,
  presetDeltaForBox,
  resetPatch,
  sizePatch,
  type FitMode,
  type FlipAxis,
  type PositionPreset,
} from './transformOps'

/** Coalesce key for arrow-key nudges: a quick burst is one undo step. */
export const NUDGE_COALESCE_KEY = 'layout:nudge'

/** Selected clips visible at the playhead, with their boxes (topmost first). */
export function selectedVisuals(measureText: TextMeasurer = canvasTextMeasurer): {
  visuals: VisualOverlay[]
  frame: { w: number; h: number }
} {
  const st = useEditor.getState()
  const all = collectActiveVisuals(st.project, st.playhead, measureText)
  return {
    visuals: all.filter((o) => st.selection.includes(o.clip.id)),
    frame: { w: st.project.width, h: st.project.height },
  }
}

/** Default reference: the frame for one object, the selection for 2+. */
export function defaultRelativeTo(count: number): AlignRelativeTo {
  return count >= 2 ? 'selection' : 'frame'
}

function applyDeltas(deltas: readonly LayoutDelta[], coalesceKey?: string): void {
  const st = useEditor.getState()
  const patches: { id: ID; patch: Partial<Transform> }[] = []
  for (const d of deltas) {
    if (d.dx === 0 && d.dy === 0) continue
    const clip = st.project.clips.find((c) => c.id === d.id)
    if (!clip) continue
    patches.push({
      id: d.id,
      patch: { x: clip.transform.x + d.dx, y: clip.transform.y + d.dy },
    })
  }
  if (patches.length) st.setTransforms(patches, coalesceKey)
}

export function alignSelection(
  edge: AlignEdge,
  relativeTo?: AlignRelativeTo,
  measureText?: TextMeasurer,
): void {
  const { visuals, frame } = selectedVisuals(measureText)
  if (visuals.length === 0) return
  const ref = visuals.length < 2 ? 'frame' : (relativeTo ?? 'selection')
  const items = visuals.map((o) => ({
    id: o.clip.id,
    bounds: axisAlignedBounds(o.box),
  }))
  applyDeltas(alignDeltas(items, edge, ref, frame))
}

export function distributeSelection(
  axis: DistributeAxis,
  measureText?: TextMeasurer,
): void {
  const { visuals } = selectedVisuals(measureText)
  const items = visuals.map((o) => ({
    id: o.clip.id,
    bounds: axisAlignedBounds(o.box),
  }))
  applyDeltas(distributeDeltas(items, axis))
}

/** Move the selection by (dx, dy) project px; quick repeats = one undo step. */
export function nudgeSelection(
  dx: number,
  dy: number,
  measureText?: TextMeasurer,
): void {
  const { visuals } = selectedVisuals(measureText)
  applyDeltas(
    visuals.map((o) => ({ id: o.clip.id, dx, dy })),
    NUDGE_COALESCE_KEY,
  )
}

// ── Transform tools ─────────────────────────────────────────────────────────

/**
 * Visual clips `ids` (default: the selection) with boxes placed from their
 * stored transform, whether or not they are under the playhead. Audio, live
 * clips and clips off video / overlay tracks are skipped.
 */
export function transformTargets(
  ids?: readonly ID[],
  measureText: TextMeasurer = canvasTextMeasurer,
): VisualOverlay[] {
  const st = useEditor.getState()
  const want = ids ?? st.selection
  const out: VisualOverlay[] = []
  for (const id of want) {
    const clip = st.project.clips.find((c) => c.id === id)
    if (!clip || clip.isLive) continue
    const track = st.project.tracks.find((t) => t.id === clip.trackId)
    if (!track || (track.kind !== 'video' && track.kind !== 'overlay')) continue
    const source = st.project.sources.find((s) => s.id === clip.sourceId)
    if (!source || source.kind === 'audio') continue
    const transform = clip.transform
    const box = visualBox(st.project, track, source, transform, measureText, clip.crop)
    if (!box) continue
    out.push({ clip, source, track, transform, box })
  }
  return out
}

function apply(patches: TransformPatch[]): void {
  if (patches.length) useEditor.getState().setTransforms(patches)
}

/** Mirror each object in place (keyframed scales are mirrored too). */
export function flipSelection(
  axis: FlipAxis,
  ids?: readonly ID[],
  measureText?: TextMeasurer,
): void {
  apply(
    transformTargets(ids, measureText).map((o) => ({
      id: o.clip.id,
      patch: flipPatch(o.box, o.transform, axis),
      negateKeyframes: [axis === 'h' ? 'scaleX' : 'scaleY'],
    })),
  )
}

/** Scale each object to fit inside / cover the frame, centred. */
export function fitSelection(
  mode: FitMode,
  ids?: readonly ID[],
  measureText?: TextMeasurer,
): void {
  const { width, height } = useEditor.getState().project
  apply(
    transformTargets(ids, measureText).map((o) => ({
      id: o.clip.id,
      patch: fitPatch(o.box, { w: width, h: height }, mode),
    })),
  )
}

/** Reset position / scale / rotation / anchor and the crop (opacity kept). */
export function resetSelection(ids?: readonly ID[], measureText?: TextMeasurer): void {
  apply(
    transformTargets(ids, measureText).map((o) => ({
      id: o.clip.id,
      patch: resetPatch(),
      crop: null,
    })),
  )
}

/** Move each object's bounds to a 9-point preset (5 % margin). */
export function positionSelection(
  preset: PositionPreset,
  ids?: readonly ID[],
  measureText?: TextMeasurer,
): void {
  const { width, height } = useEditor.getState().project
  apply(
    transformTargets(ids, measureText).map((o) => {
      const d = presetDeltaForBox(o.box, preset, { w: width, h: height })
      return {
        id: o.clip.id,
        patch: { x: o.transform.x + d.dx, y: o.transform.y + d.dy },
      }
    }),
  )
}

/** Move a clip's anchor, keeping the object where it is on screen. */
export function setClipAnchor(
  id: ID,
  anchorX: number,
  anchorY: number,
  measureText?: TextMeasurer,
): void {
  const o = transformTargets([id], measureText)[0]
  if (!o) return
  apply([
    { id, patch: anchorChangePatch(boxBase(o.box), o.transform, anchorX, anchorY) },
  ])
}

/**
 * Set a clip's crop (null / empty = none), keeping the remaining content
 * where it is on screen. Pictures only (video / image / animation).
 */
export function setClipCrop(
  id: ID,
  crop: Partial<ClipCrop> | null,
  measureText?: TextMeasurer,
): void {
  const o = transformTargets([id], measureText)[0]
  if (!o) return
  const k = o.source.kind
  if (k !== 'video' && k !== 'image' && k !== 'animation') return
  const next = normalizeCrop(crop)
  const t = cropChangePatch(o.box.fullBase, o.transform, o.box.crop, next)
  apply([{ id, patch: { x: t.x, y: t.y }, crop: next ?? null }])
}

/** Set a clip's width or height in project px (aspect lock respected). */
export function setClipSize(
  id: ID,
  next: { width?: number; height?: number },
  measureText?: TextMeasurer,
): void {
  const o = transformTargets([id], measureText)[0]
  if (!o) return
  apply([
    { id, patch: sizePatch(o.box.baseWidth, o.box.baseHeight, o.transform, next) },
  ])
}

/**
 * The "relative to" choice shared by the preview toolbar and the Inspector.
 * 'auto' = frame for one object, selection for several.
 */
export const useAlignPrefs = create<{
  relativeTo: 'auto' | AlignRelativeTo
  setRelativeTo: (v: 'auto' | AlignRelativeTo) => void
}>((set) => ({
  relativeTo: 'auto',
  setRelativeTo: (relativeTo) => {
    set({ relativeTo })
  },
}))

/** The reference alignment uses for `count` selected objects. */
export function effectiveRelativeTo(
  pref: 'auto' | AlignRelativeTo,
  count: number,
): AlignRelativeTo {
  if (count < 2) return 'frame'
  return pref === 'auto' ? defaultRelativeTo(count) : pref
}

// ── Layer order ─────────────────────────────────────────────────────────────

/** Event that opens the "Paste attributes" dialog. */
export const PASTE_ATTRIBUTES_EVENT = 'ir:paste-attributes'

/**
 * Bring forward / send backward / to front / to back for `ids` (default:
 * the selection), one undo step. Returns how many clips moved (0 = already
 * there, or nothing visual selected).
 */
export function arrangeSelection(dir: LayerDirection, ids?: readonly ID[]): number {
  const st = useEditor.getState()
  return st.reorderClips(ids ?? st.selection, dir)
}

export const ARRANGE_LABELS: Record<LayerDirection, string> = {
  forward: 'Bring forward',
  backward: 'Send backward',
  front: 'Bring to front',
  back: 'Send to back',
}
