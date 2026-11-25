/**
 * Shared "what is drawn at time t" logic for the preview compositor and the
 * exporter. Both call `buildScene` to decide which clips are visible per
 * track (topmost-clip rule, transitions, hidden tracks, live clips) and
 * `drawScene` to paint them (fit, T·R·S transform, colour filter, transition
 * alpha / clip rects / slide offsets / dips), so the two can't drift apart.
 *
 * Everything here works in PROJECT pixels. `drawScene` scales the context to
 * the output canvas, so transform x/y, text sizes and blur radii look the
 * same at any preview size or export resolution.
 */
import type {
  Clip,
  ColorAdjust,
  ID,
  MediaSource,
  Project,
  Track,
  Transform,
  TransitionKind,
} from '../timeline/types'
import { isTrackHidden } from '../timeline/trackState'
import { sampleClipProp } from './keyframes'
import { drawTextSource, measureTextLayout } from './textRender'
import {
  computeCrop,
  fadeEdges,
  needsCrop,
  sampleEffects,
  type CropSample,
  type EffectSample,
} from '../effects/sample'
import { drawSpotlight } from '../effects/spotlight'
import { drawElement, getTemplate, type ElementParams } from '../elements'
import { drawShape } from '../shapes'
import {
  applyPlacement,
  cropBaseBox,
  cropSourceRect,
  effectiveCrop,
  isDefaultAnchor,
  placeObject,
  placementPoint,
  type BaseRect,
} from '../layout/placement'

// ── Clip timing ─────────────────────────────────────────────────────────────

export function clipDuration(c: Clip): number {
  return Math.max(0, (c.sourceOut - c.sourceIn) / Math.max(0.1, c.speed ?? 1))
}

export function clipEnd(c: Clip): number {
  return c.timelineStart + clipDuration(c)
}

/**
 * True if `c` is on screen at `t`. The end is exclusive, except for live
 * clips: their end IS the live edge, which the preview sits on while
 * following a recording.
 */
export function isClipActiveAt(c: Clip, t: number): boolean {
  if (t < c.timelineStart) return false
  const end = clipEnd(c)
  return t < end || (!!c.isLive && t <= end)
}

/**
 * The topmost active clip on `trackId` at `t`: the one with the highest
 * timelineStart; ties go to the clip later in the array. Used for visuals,
 * audio and the preview selection box alike.
 */
export function findActiveClip(
  clips: readonly Clip[],
  trackId: string,
  t: number,
  includeLive = true,
): Clip | undefined {
  let best: Clip | undefined
  for (const c of clips) {
    if (c.trackId !== trackId) continue
    if (!includeLive && c.isLive) continue
    if (!isClipActiveAt(c, t)) continue
    if (!best || c.timelineStart >= best.timelineStart) best = c
  }
  return best
}

/**
 * Source-media time shown by `clip` at timeline time `t`, clamped to the
 * trimmed range so transitions hold the first/last frame instead of showing
 * trimmed-out footage. `holding` is true when the clamp kicked in.
 */
export function clipSourceTime(
  clip: Clip,
  t: number,
): { time: number; holding: boolean } {
  const raw = clip.sourceIn + (t - clip.timelineStart) * clip.speed
  const max = Math.max(clip.sourceIn, clip.sourceOut - 0.001)
  if (raw < clip.sourceIn) return { time: clip.sourceIn, holding: true }
  if (raw > max) return { time: max, holding: raw > clip.sourceOut }
  return { time: raw, holding: false }
}

// ── Transitions ─────────────────────────────────────────────────────────────

/** The center join time between two clips (midpoint of from.end and to.start). */
export function transitionJoin(from: Clip, to: Clip): number {
  return (clipEnd(from) + to.timelineStart) / 2
}

/** Transition window, centred on the join. */
export function transitionWindow(
  from: Clip,
  to: Clip,
  duration: number,
): { start: number; end: number } {
  const join = transitionJoin(from, to)
  return { start: join - duration / 2, end: join + duration / 2 }
}

/** Progress 0..1 through the transition at `t`, or null outside its window. */
export function transitionProgress(
  from: Clip,
  to: Clip,
  duration: number,
  t: number,
): number | null {
  if (duration <= 0) return null
  const { start, end } = transitionWindow(from, to, duration)
  if (t < start || t >= end) return null
  return Math.max(0, Math.min(1, (t - start) / duration))
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Per-clip drawing modifiers a transition applies. */
export interface TransitionPart {
  alpha: number
  clipRect?: Rect
  offset?: { x: number; y: number }
  dip?: { color: string; alpha: number }
}

/**
 * What each side of a transition looks like at progress `p` on a `w`×`h`
 * frame. `null` means that side isn't drawn. The outgoing clip is always
 * drawn first, the incoming one on top of it.
 *
 *  - crossfade: outgoing stays opaque, incoming fades in over it (no dip to
 *    black mid-way).
 *  - wipe-*: incoming revealed through a growing rect.
 *  - slide-*: incoming translated in while outgoing is pushed out.
 *  - dip-*: first half fades outgoing to the colour, second half fades the
 *    colour to incoming.
 */
export function transitionParts(
  kind: TransitionKind,
  p: number,
  w: number,
  h: number,
): { from: TransitionPart | null; to: TransitionPart | null } {
  switch (kind) {
    case 'crossfade':
      return { from: { alpha: 1 }, to: { alpha: p } }
    case 'wipe-left':
      return {
        from: { alpha: 1 },
        to: { alpha: 1, clipRect: { x: 0, y: 0, w: p * w, h } },
      }
    case 'wipe-right':
      return {
        from: { alpha: 1 },
        to: { alpha: 1, clipRect: { x: (1 - p) * w, y: 0, w: p * w, h } },
      }
    case 'wipe-up':
      return {
        from: { alpha: 1 },
        to: { alpha: 1, clipRect: { x: 0, y: 0, w, h: p * h } },
      }
    case 'wipe-down':
      return {
        from: { alpha: 1 },
        to: { alpha: 1, clipRect: { x: 0, y: (1 - p) * h, w, h: p * h } },
      }
    // Slides enter from the same edge the matching wipe reveals from.
    case 'slide-left':
      return {
        from: { alpha: 1, offset: { x: p * w, y: 0 } },
        to: { alpha: 1, offset: { x: -(1 - p) * w, y: 0 } },
      }
    case 'slide-right':
      return {
        from: { alpha: 1, offset: { x: -p * w, y: 0 } },
        to: { alpha: 1, offset: { x: (1 - p) * w, y: 0 } },
      }
    case 'dip-black':
    case 'dip-white': {
      const color = kind === 'dip-black' ? '#000000' : '#ffffff'
      return p < 0.5
        ? { from: { alpha: 1, dip: { color, alpha: p * 2 } }, to: null }
        : { from: null, to: { alpha: 1, dip: { color, alpha: (1 - p) * 2 } } }
    }
  }
}

// ── Scene ───────────────────────────────────────────────────────────────────

export interface SceneLayer extends TransitionPart {
  clip: Clip
  source: MediaSource
  /** Clamped source time at the scene time (see clipSourceTime). */
  sourceTime: number
  holding: boolean
  live: boolean
  /**
   * Decoder pool key: the sourceId, or the clip id when the same source is
   * visible in more than one layer at this time (so each gets its own
   * <video> and they don't fight over one element's currentTime).
   */
  key: string
}

export interface SceneGroup {
  track: Track
  overlay: boolean
  layers: SceneLayer[]
  /**
   * True for the lowest group that draws anything. Its dips cover the whole
   * frame; dips on higher tracks cover only the clip itself so they never
   * darken the tracks below or above.
   */
  dipFullFrame: boolean
}

export interface BuildSceneOptions {
  /** Include still-recording clips (preview draws them from the live stream). */
  includeLive: boolean
}

/** Visible layers per video/overlay track at `t`, in paint order (bottom → top). */
export function buildScene(
  project: Project,
  t: number,
  opts: BuildSceneOptions,
): SceneGroup[] {
  const groups: SceneGroup[] = []
  const tracks = [...project.tracks]
    .reverse()
    .filter((track) => track.kind === 'video' || track.kind === 'overlay')
  const usable = (c: Clip | undefined): c is Clip =>
    !!c && (opts.includeLive || !c.isLive)

  for (const track of tracks) {
    if (isTrackHidden(project, track)) continue
    const picked: { clip: Clip; part: TransitionPart }[] = []
    const seen = new Set<string>()

    for (const tr of project.transitions) {
      const from = project.clips.find(
        (c) => c.id === tr.fromClipId && c.trackId === track.id,
      )
      const to = project.clips.find(
        (c) => c.id === tr.toClipId && c.trackId === track.id,
      )
      if (!usable(from) || !usable(to)) continue
      if (seen.has(from.id) || seen.has(to.id)) continue
      const p = transitionProgress(from, to, tr.duration, t)
      if (p === null) continue
      const parts = transitionParts(tr.kind, p, project.width, project.height)
      seen.add(from.id)
      seen.add(to.id)
      if (parts.from) picked.push({ clip: from, part: parts.from })
      if (parts.to) picked.push({ clip: to, part: parts.to })
    }

    if (picked.length === 0) {
      const top = findActiveClip(project.clips, track.id, t, opts.includeLive)
      if (top) picked.push({ clip: top, part: { alpha: 1 } })
    }

    const layers: SceneLayer[] = []
    for (const { clip, part } of picked) {
      const source = project.sources.find((s) => s.id === clip.sourceId)
      if (!source || source.kind === 'audio') continue
      if (source.kind === 'text' && !source.text) continue
      if (source.kind === 'element' && !source.element) continue
      if (source.kind === 'shape' && !source.shape) continue
      if (source.kind === 'animation' && !source.opfsPath) continue
      const st = clipSourceTime(clip, t)
      layers.push({
        ...part,
        clip,
        source,
        sourceTime: st.time,
        holding: st.holding,
        live: !!clip.isLive,
        key: clip.sourceId,
      })
    }
    if (layers.length === 0) continue
    groups.push({
      track,
      overlay: track.kind === 'overlay',
      layers,
      dipFullFrame: groups.length === 0,
    })
  }

  // Same source visible more than once → key those layers by clip id.
  const counts = new Map<string, number>()
  for (const g of groups) {
    for (const l of g.layers)
      counts.set(l.clip.sourceId, (counts.get(l.clip.sourceId) ?? 0) + 1)
  }
  for (const g of groups) {
    for (const l of g.layers) {
      if ((counts.get(l.clip.sourceId) ?? 0) > 1) l.key = l.clip.id
    }
  }
  return groups
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** Untransformed placement of a clip's media, in project pixels. */
export type BaseBox = BaseRect

/**
 * Where media of size srcW×srcH sits before the clip transform: contain-fit
 * for main tracks, a 25%-width PIP pinned bottom-right for overlay tracks.
 */
export function baseBox(
  projectW: number,
  projectH: number,
  overlay: boolean,
  srcW: number,
  srcH: number,
): BaseBox {
  if (overlay) {
    const w = projectW * 0.25
    const h = w * (srcH / Math.max(1, srcW))
    const pad = projectW * 0.02
    return { cx: projectW - w / 2 - pad, cy: projectH - h / 2 - pad, w, h }
  }
  const sAspect = srcW / Math.max(1, srcH)
  const dAspect = projectW / projectH
  let w = projectW
  let h = projectH
  if (sAspect > dAspect) h = projectW / sAspect
  else w = projectH * sAspect
  return { cx: projectW / 2, cy: projectH / 2, w, h }
}

/** Element boxes are authored at 1080p (template `size`). */
const ELEMENT_REF_HEIGHT = 1080

/**
 * Untransformed placement of an Elements-pack overlay: the template's size
 * (authored for 1080p) scaled to the project height and capped at 90 % of
 * the frame, placed by category — lower thirds bottom-left, social buttons
 * bottom-centre, everything else centred.
 */
export function elementBaseBox(
  projectW: number,
  projectH: number,
  source: Pick<MediaSource, 'width' | 'height' | 'element'>,
): BaseBox {
  const tpl = source.element ? getTemplate(source.element.template) : undefined
  const srcW = tpl?.size.w ?? source.width ?? 640
  const srcH = tpl?.size.h ?? source.height ?? 200
  let k = projectH / ELEMENT_REF_HEIGHT
  k = Math.min(
    k,
    (projectW * 0.9) / Math.max(1, srcW),
    (projectH * 0.9) / Math.max(1, srcH),
  )
  const w = srcW * k
  const h = srcH * k
  const margin = projectH * 0.06
  const bottom = projectH - margin - h / 2
  switch (tpl?.category) {
    case 'title':
      return { cx: projectW * 0.05 + w / 2, cy: bottom, w, h }
    case 'social':
      return { cx: projectW / 2, cy: bottom, w, h }
    default:
      return { cx: projectW / 2, cy: projectH / 2, w, h }
  }
}

/**
 * Untransformed placement of a vector shape: its intrinsic size (authored
 * for 1080p, like elements) scaled to the project height, capped at 90 % of
 * the frame, centred.
 */
export function shapeBaseBox(
  projectW: number,
  projectH: number,
  source: Pick<MediaSource, 'width' | 'height' | 'shape'>,
): BaseBox {
  const srcW = source.shape?.width ?? source.width ?? 400
  const srcH = source.shape?.height ?? source.height ?? 400
  const k = Math.min(
    projectH / ELEMENT_REF_HEIGHT,
    (projectW * 0.9) / Math.max(1, srcW),
    (projectH * 0.9) / Math.max(1, srcH),
  )
  return { cx: projectW / 2, cy: projectH / 2, w: srcW * k, h: srcH * k }
}

/** Vector (template / shape) layers: their untransformed box, or null. */
export function vectorBaseBox(
  projectW: number,
  projectH: number,
  source: MediaSource,
): BaseBox | null {
  if (source.kind === 'element') return elementBaseBox(projectW, projectH, source)
  if (source.kind === 'shape') return shapeBaseBox(projectW, projectH, source)
  return null
}

/** An element source's params in the shape templates take (booleans dropped). */
export function elementParams(source: MediaSource): ElementParams {
  const out: ElementParams = {}
  for (const [k, v] of Object.entries(source.element?.params ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v
  }
  return out
}

/**
 * The clip transform at timeline time `t`, keyframes applied (the anchor
 * and aspect lock are not animated and pass through).
 */
export function sampleTransform(clip: Clip, t: number): Transform {
  const local = t - clip.timelineStart
  const tf = clip.transform
  const out: Transform = {
    x: sampleClipProp(clip, 'x', local, tf.x),
    y: sampleClipProp(clip, 'y', local, tf.y),
    scaleX: sampleClipProp(clip, 'scaleX', local, tf.scaleX),
    scaleY: sampleClipProp(clip, 'scaleY', local, tf.scaleY),
    rotation: sampleClipProp(clip, 'rotation', local, tf.rotation),
    opacity: sampleClipProp(clip, 'opacity', local, tf.opacity),
  }
  if (tf.anchorX !== undefined) out.anchorX = tf.anchorX
  if (tf.anchorY !== undefined) out.anchorY = tf.anchorY
  if (tf.lockAspect !== undefined) out.lockAspect = tf.lockAspect
  return out
}

/**
 * CSS filter for a colour adjustment. `pxScale` = output pixels per project
 * pixel: canvas filter lengths ignore the context transform, so blur is
 * scaled explicitly to look the same at every output size.
 */
export function colorFilter(
  c: ColorAdjust | undefined,
  pxScale: number,
): string | null {
  if (!c) return null
  const parts: string[] = []
  if (c.brightness !== 1) parts.push(`brightness(${c.brightness})`)
  if (c.contrast !== 1) parts.push(`contrast(${c.contrast})`)
  if (c.saturation !== 1) parts.push(`saturate(${c.saturation})`)
  if (c.hue !== 0) parts.push(`hue-rotate(${c.hue}deg)`)
  if (c.blur > 0) parts.push(`blur(${c.blur * pxScale}px)`)
  return parts.length ? parts.join(' ') : null
}

/** Maps the project frame into an output canvas (uniform scale, centred). */
export interface SceneView {
  width: number
  height: number
  scale: number
  offsetX: number
  offsetY: number
}

export function fitView(
  projectW: number,
  projectH: number,
  outW: number,
  outH: number,
): SceneView {
  const scale = Math.min(outW / projectW, outH / projectH)
  return {
    width: outW,
    height: outH,
    scale,
    offsetX: (outW - projectW * scale) / 2,
    offsetY: (outH - projectH * scale) / 2,
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/** Media elements (preview) or decoded frames on a canvas (export). */
export type SceneImage =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap

/** Pixel size of a scene image. */
export function mediaSize(el: SceneImage): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth, h: el.videoHeight }
  if (el instanceof HTMLImageElement) return { w: el.naturalWidth, h: el.naturalHeight }
  return { w: el.width, h: el.height }
}

export interface DrawSceneOptions {
  /**
   * Draw this clip without its camera effects (zoom, Ken Burns, shake,
   * spotlight) — used while its zoom focus / spotlight is edited on the
   * preview. Fades still apply.
   */
  suppressEffects?: ID | undefined
  /**
   * Per-layer image hook run right after `getImage` (Phase 2: chroma key).
   * Must be synchronous and return the image to draw (or `el` unchanged).
   */
  processImage?: ((layer: SceneLayer, el: SceneImage) => SceneImage) | undefined
  /**
   * Leave the background transparent instead of filling it black (merging
   * overlays with alpha).
   */
  transparent?: boolean | undefined
  /**
   * Crop editing: also draw this clip's cropped-away picture, dimmed, around
   * the kept region (preview crop mode).
   */
  cropGhost?: ID | undefined
}

/**
 * Paint a scene. `getImage` returns the ready media element for a layer, or
 * null to skip it. Areas outside the project frame stay black.
 *
 * Per layer: save → blend mode → transition offset → transition clipRect →
 *  - text: alpha × fade, shake translate, draw
 *  - element / shape: vector drawing in the placed box (fade, shake, grow)
 *  - media: getImage → processImage → size → baseBox → alpha × fade + colour
 *    filter → translate/rotate → spotlight, or one cropped drawImage
 * → box dip (not faded) → restore → full-frame dip.
 *
 * Zoom / Ken Burns / shake are a SOURCE crop (9-argument drawImage), so the
 * layer box, transforms, transitions and PIP placement are unchanged.
 */
/**
 * 'grow' zoom: scale the object about its point (fx, fy) — given in the
 * object's own box (w × h, centred on the current origin) — so that point
 * stays put on screen while the object gets bigger.
 */
function applyGrow(
  ctx: CanvasRenderingContext2D,
  g: CropSample,
  w: number,
  h: number,
  keepInFrame?: { cx: number; cy: number; W: number; H: number } | null,
): void {
  if (g.scale <= 1.0001) return
  const gx = (g.fx - 0.5) * w
  const gy = (g.fy - 0.5) * h
  if (keepInFrame) {
    // Slide the grown object back inside the frame (e.g. a corner webcam
    // bubble grows into the picture instead of off its edge). Bigger than the
    // frame: centre it.
    const shift = (c: number, size: number, focus: number, max: number) => {
      const half = Math.abs(size) / 2
      const lo = c + focus + (-half - focus) * g.scale
      const hi = c + focus + (half - focus) * g.scale
      if (hi - lo >= max) return max / 2 - (lo + hi) / 2
      if (lo < 0) return -lo
      if (hi > max) return max - hi
      return 0
    }
    ctx.translate(
      shift(keepInFrame.cx, w, gx, keepInFrame.W),
      shift(keepInFrame.cy, h, gy, keepInFrame.H),
    )
  }
  ctx.translate(gx, gy)
  ctx.scale(g.scale, g.scale)
  ctx.translate(-gx, -gy)
}

/**
 * Text and elements have no picture to zoom into, so an 'inside' zoom on
 * them behaves like 'grow'.
 */
function objectGrow(fx: EffectSample | null): CropSample | null {
  if (!fx) return null
  if (fx.grow) return fx.grow
  return fx.crop.scale > 1.0001 ? fx.crop : null
}

/**
 * Where a layer's box-normalized point (u, v) - in the object's own (kept,
 * unmirrored) coordinates - is on the project frame, before effects. Uses
 * the source's intrinsic size, so it needs no decoded frame. Text needs its
 * measured scale-1 size (`textSize`); without it, its anchor is used.
 */
export function layerPointOnFrame(
  W: number,
  H: number,
  overlay: boolean,
  layer: Pick<SceneLayer, 'source' | 'clip'>,
  tf: Transform,
  u: number,
  v: number,
  textSize?: { w: number; h: number } | null,
): { x: number; y: number } {
  const src = layer.source
  let base: BaseRect
  if (src.kind === 'text') {
    if (!textSize) return { x: W / 2 + tf.x, y: H / 2 + tf.y }
    base = { cx: W / 2, cy: H / 2, w: textSize.w, h: textSize.h }
  } else if (src.kind === 'element' || src.kind === 'shape') {
    base = vectorBaseBox(W, H, src) ?? { cx: W / 2, cy: H / 2, w: 0, h: 0 }
  } else {
    base = cropBaseBox(
      baseBox(W, H, overlay && !src.fullFrame, src.width || W, src.height || H),
      effectiveCrop(src.kind, layer.clip.crop),
    )
  }
  return placementPoint(placeObject(base, tf), u, v)
}

/**
 * Scale-1 size of a text source as `drawTextSource` lays it out, measured on
 * `ctx` without painting anything.
 */
function measureTextSize(
  ctx: CanvasRenderingContext2D,
  layer: SceneLayer,
): { w: number; h: number } | null {
  const text = layer.source.text
  if (!text) return null
  // Layout only: the same box drawTextSource returns at scale 1, without
  // filling, stroking or blurring anything (this runs every frame).
  const layout = measureTextLayout(ctx, text)
  return { w: layout.width, h: layout.height }
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  project: Project,
  t: number,
  groups: readonly SceneGroup[],
  getImage: (layer: SceneLayer) => SceneImage | null,
  view: SceneView,
  opts: DrawSceneOptions = {},
): void {
  const W = project.width
  const H = project.height
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (opts.transparent) {
    ctx.clearRect(0, 0, view.width, view.height)
  } else {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, view.width, view.height)
  }
  ctx.setTransform(view.scale, 0, 0, view.scale, view.offsetX, view.offsetY)
  ctx.beginPath()
  ctx.rect(0, 0, W, H)
  ctx.clip()

  // Sample every layer's effects once; a 'frame' zoom (topmost wins) scales
  // the whole composition around that object's focus point.
  const samples = new Map<SceneLayer, EffectSample | null>()
  let frameZoom: { x: number; y: number; scale: number } | null = null
  for (const group of groups) {
    for (const layer of group.layers) {
      const clip = layer.clip
      const fx = clip.effects?.length
        ? sampleEffects(clip, t - clip.timelineStart, layer.sourceTime, {
            ...fadeEdges(project, clip.id),
            suppressCamera: opts.suppressEffects === clip.id,
          })
        : null
      samples.set(layer, fx)
      if (fx?.frame && fx.frame.scale > 1.0001 && layer.alpha > 0.001) {
        const tf = sampleTransform(clip, t)
        const p = layerPointOnFrame(
          W,
          H,
          group.overlay,
          layer,
          tf,
          fx.frame.fx,
          fx.frame.fy,
          layer.source.kind === 'text' ? measureTextSize(ctx, layer) : null,
        )
        frameZoom = {
          x: Math.min(W, Math.max(0, p.x)),
          y: Math.min(H, Math.max(0, p.y)),
          scale: fx.frame.scale,
        }
      }
    }
  }
  if (frameZoom) {
    // Like a camera framing the object: show a W/s × H/s viewport centred on
    // the focus point, slid back inside the frame so no edge ever shows.
    const sc = frameZoom.scale
    const vw = W / sc
    const vh = H / sc
    const vx = Math.min(W - vw, Math.max(0, frameZoom.x - vw / 2))
    const vy = Math.min(H - vh, Math.max(0, frameZoom.y - vh / 2))
    ctx.scale(sc, sc)
    ctx.translate(-vx, -vy)
  }

  for (const group of groups) {
    for (const layer of group.layers) {
      if (layer.alpha <= 0.001 && !layer.dip) continue
      const tf = sampleTransform(layer.clip, t)
      const boxDip = layer.dip && !group.dipFullFrame ? layer.dip : null
      const clip = layer.clip
      const fx = samples.get(layer) ?? null
      const fade = fx ? fx.opacityMul : 1
      ctx.save()
      // Blend with the layers below (reset for the transition dip below).
      const blend =
        clip.blendMode && clip.blendMode !== 'normal' ? clip.blendMode : null
      if (blend) ctx.globalCompositeOperation = blend
      if (layer.offset) ctx.translate(layer.offset.x, layer.offset.y)
      if (layer.clipRect) {
        ctx.beginPath()
        ctx.rect(layer.clipRect.x, layer.clipRect.y, layer.clipRect.w, layer.clipRect.h)
        ctx.clip()
      }
      if (layer.source.kind === 'text' && layer.source.text) {
        // Text gets only fade + shake (as a plain translate).
        ctx.globalAlpha = tf.opacity * layer.alpha * fade
        if (fx?.shake) ctx.translate(fx.shake.dx, fx.shake.dy)
        const tg = objectGrow(fx)
        // drawTextSource rotates / scales about the box centre. With another
        // anchor, hand it the centre the anchored placement gives (the same
        // mapping: centre, rotation and scale determine it).
        let drawTf: Transform = tf
        let cx = W / 2 + tf.x
        let cy = H / 2 + tf.y
        if (!isDefaultAnchor(tf)) {
          const size = measureTextSize(ctx, layer)
          if (size) {
            const p = placeObject({ cx: W / 2, cy: H / 2, w: size.w, h: size.h }, tf)
            cx = p.centerX
            cy = p.centerY
            drawTf = { ...tf, x: cx - W / 2, y: cy - H / 2 }
          }
        }
        if (tg) {
          // Text grows about its box centre.
          ctx.translate(cx, cy)
          applyGrow(ctx, { ...tg, fx: 0.5, fy: 0.5 }, 0, 0)
          ctx.translate(-cx, -cy)
        }
        const r = drawTextSource(ctx, layer.source.text, W, H, drawTf, view.scale)
        if (boxDip) {
          if (blend) ctx.globalCompositeOperation = 'source-over'
          ctx.globalAlpha = boxDip.alpha
          ctx.fillStyle = boxDip.color
          ctx.translate(r.x + r.w / 2, r.y + r.h / 2)
          if (tf.rotation) ctx.rotate((tf.rotation * Math.PI) / 180)
          ctx.fillRect(-r.w / 2, -r.h / 2, r.w, r.h)
        }
      } else if (
        (layer.source.kind === 'element' && layer.source.element) ||
        (layer.source.kind === 'shape' && layer.source.shape)
      ) {
        // Vector overlay (element template / shape) drawn straight into the
        // context (sharp at any size). Like text: no picture effects.
        const src = layer.source
        const base = vectorBaseBox(W, H, src) ?? { cx: W / 2, cy: H / 2, w: 0, h: 0 }
        const p = placeObject(base, tf)
        const w = p.w
        const h = p.h
        ctx.globalAlpha = tf.opacity * layer.alpha * fade
        const flt = colorFilter(clip.color, view.scale)
        if (flt) ctx.filter = flt
        if (fx?.shake) ctx.translate(fx.shake.dx, fx.shake.dy)
        // Origin -> box centre, rotated about the anchor.
        applyPlacement(ctx, p)
        const eg = objectGrow(fx)
        if (eg)
          applyGrow(
            ctx,
            eg,
            w,
            h,
            tf.rotation ? null : { cx: p.centerX, cy: p.centerY, W, H },
          )
        // Negative scale = mirror; templates and shapes take a positive box.
        if (w < 0 || h < 0) ctx.scale(w < 0 ? -1 : 1, h < 0 ? -1 : 1)
        if (src.shape) {
          drawShape(ctx, src.shape, { w: Math.abs(w), h: Math.abs(h) })
        } else if (src.element) {
          drawElement(
            ctx,
            src.element.template,
            elementParams(src),
            layer.sourceTime,
            clip.sourceOut,
            { w: Math.abs(w), h: Math.abs(h) },
          )
        }
        if (boxDip) {
          if (blend) ctx.globalCompositeOperation = 'source-over'
          ctx.filter = 'none'
          ctx.globalAlpha = boxDip.alpha
          ctx.fillStyle = boxDip.color
          ctx.fillRect(-Math.abs(w) / 2, -Math.abs(h) / 2, Math.abs(w), Math.abs(h))
        }
      } else {
        const raw = getImage(layer)
        const el = raw && opts.processImage ? opts.processImage(layer, raw) : raw
        const size = el ? mediaSize(el) : null
        if (el && size && size.w && size.h) {
          // Providers may render at a different pixel size (Lottie hi-dpi):
          // lay animations out by their intrinsic size, crop by pixel size.
          const src = layer.source
          const layout =
            src.kind === 'animation' && src.width && src.height
              ? { w: src.width, h: src.height }
              : size
          const fullBase = baseBox(
            W,
            H,
            group.overlay && !src.fullFrame,
            layout.w,
            layout.h,
          )
          // User crop: the box shrinks to the kept region (content stays put).
          const crop = effectiveCrop(src.kind, clip.crop)
          const base = cropBaseBox(fullBase, crop)
          const p = placeObject(base, tf)
          const w = p.w
          const h = p.h
          const aw = Math.abs(w)
          const ah = Math.abs(h)
          ctx.globalAlpha = tf.opacity * layer.alpha * fade
          const flt = colorFilter(layer.clip.color, view.scale)
          if (flt) ctx.filter = flt
          // Origin -> box centre, rotated about the anchor (matches the
          // preview selection box).
          applyPlacement(ctx, p)
          if (fx?.grow)
            applyGrow(
              ctx,
              fx.grow,
              w,
              h,
              // Axis-aligned objects only (a rotated box needs a rotated fit).
              tf.rotation ? null : { cx: p.centerX, cy: p.centerY, W, H },
            )
          // Negative scale = mirror; everything below draws a positive box.
          if (w < 0 || h < 0) ctx.scale(w < 0 ? -1 : 1, h < 0 ? -1 : 1)
          // The kept region in source pixels (effects work inside it).
          const region = cropSourceRect(crop, size.w, size.h)
          if (crop && opts.cropGhost === clip.id) {
            // Crop mode: the cropped-away picture, dimmed, around the box.
            const kx = aw / Math.max(1e-6, base.w)
            const ky = ah / Math.max(1e-6, base.h)
            const gw = fullBase.w * kx
            const gh = fullBase.h * ky
            const gx = (fullBase.cx - base.cx) * kx
            const gy = (fullBase.cy - base.cy) * ky
            const alpha = ctx.globalAlpha
            ctx.globalAlpha = alpha * 0.3
            ctx.drawImage(el, gx - gw / 2, gy - gh / 2, gw, gh)
            ctx.globalAlpha = alpha
          }
          if (fx && (fx.spotlight || needsCrop(fx))) {
            const sr = computeCrop(fx, size.w, size.h, aw, ah, region)
            if (fx.spotlight) {
              drawSpotlight(ctx, el, sr, region, aw, ah, fx.spotlight, flt, view.scale)
            } else {
              ctx.drawImage(el, sr.sx, sr.sy, sr.sw, sr.sh, -aw / 2, -ah / 2, aw, ah)
            }
          } else if (crop) {
            ctx.drawImage(
              el,
              region.sx,
              region.sy,
              region.sw,
              region.sh,
              -aw / 2,
              -ah / 2,
              aw,
              ah,
            )
          } else {
            ctx.drawImage(el, -aw / 2, -ah / 2, aw, ah)
          }
          if (boxDip) {
            if (blend) ctx.globalCompositeOperation = 'source-over'
            ctx.filter = 'none'
            ctx.globalAlpha = boxDip.alpha
            ctx.fillStyle = boxDip.color
            ctx.fillRect(-aw / 2, -ah / 2, aw, ah)
          }
        }
      }
      ctx.restore()
      if (layer.dip && group.dipFullFrame) {
        ctx.save()
        ctx.globalAlpha = Math.max(0, Math.min(1, layer.dip.alpha))
        ctx.fillStyle = layer.dip.color
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }
    }
  }
  ctx.restore()
}
