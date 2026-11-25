/**
 * Pure effect sampling: what a clip's effects do at one instant. Shared by
 * the compositor (preview + export), the preview audio mixer and the export
 * audio plan, so all of them agree.
 */
import type { Clip, ID, Project } from '../timeline/types'
import { clamp, clamp01, ease, lerp } from './easing'
import { shakeOffset } from './shake'
import {
  ADJACENT_EPS,
  type ChromaKeyEffect,
  type ClipEffect,
  type FadeEffect,
  type SpotlightShape,
  type ZoomEffect,
  type ZoomMode,
} from './types'

/** Source crop: zoom level and viewport centre (source-normalized). */
export interface CropSample {
  scale: number
  fx: number
  fy: number
}

export interface SpotlightSample {
  /** Highlighted area (top-left + size), source-normalized. */
  x: number
  y: number
  w: number
  h: number
  shape: SpotlightShape
  /** Already multiplied by the in/out ramp. */
  dim: number
  blur: number
  feather: number
}

export interface ShakeSample {
  /** Offset in project px (layer-box units). */
  dx: number
  dy: number
  /** Current max amplitude (project px) — sets the auto min-zoom. */
  amp: number
}

export interface ChromaSample {
  color: string
  similarity: number
  smoothness: number
  spill: number
}

export interface EffectSample {
  /** Zoom INTO the picture ('inside' zooms + Ken Burns + shake min-zoom). */
  crop: CropSample
  /**
   * 'grow' zoom: scale the whole object by `scale` around its source-normalized
   * point (fx, fy), which stays put on screen. null = none.
   */
  grow: CropSample | null
  /**
   * 'frame' zoom: scale the whole composition by `scale` around this object's
   * source-normalized point (fx, fy). null = none.
   */
  frame: CropSample | null
  opacityMul: number
  volumeMul: number
  shake: ShakeSample | null
  spotlight: SpotlightSample | null
  chroma: ChromaSample | null
}

/** Which fade edges may apply (false where a transition owns the edge). */
export interface FadeEdges {
  fadeIn: boolean
  fadeOut: boolean
}

export interface SampleOptions extends Partial<FadeEdges> {
  /**
   * Skip the "camera" effects (zoom, Ken Burns, shake, spotlight) — used to
   * show a clip un-zoomed while its zoom focus / spotlight is being edited.
   */
  suppressCamera?: boolean
}

const IDENTITY_CROP: CropSample = Object.freeze({ scale: 1, fx: 0.5, fy: 0.5 })

const IDENTITY: EffectSample = Object.freeze({
  crop: IDENTITY_CROP,
  grow: null,
  frame: null,
  opacityMul: 1,
  volumeMul: 1,
  shake: null,
  spotlight: null,
  chroma: null,
})

/** Ramp (source s) for spotlight dim/blur in and out. */
const SPOTLIGHT_RAMP = 0.3
/** Ramp (source s) for shake amplitude in and out. */
const SHAKE_RAMP = 0.15

function clipLength(clip: Clip): number {
  return Math.max(0, (clip.sourceOut - clip.sourceIn) / Math.max(0.1, clip.speed || 1))
}

/**
 * Fade edges that may apply to `clipId`: an edge with a transition attached
 * belongs to the transition, so the fade is ignored there (video, preview
 * mixer and export audio alike).
 */
export function fadeEdges(
  project: Pick<Project, 'transitions'>,
  clipId: ID,
): FadeEdges {
  let fadeIn = true
  let fadeOut = true
  for (const tr of project.transitions) {
    if (tr.toClipId === clipId) fadeIn = false
    if (tr.fromClipId === clipId) fadeOut = false
  }
  return { fadeIn, fadeOut }
}

/** The clip's first enabled fade effect. */
export function activeFade(clip: Clip): FadeEffect | null {
  if (!clip.effects) return null
  for (const e of clip.effects) if (e.type === 'fade' && e.enabled) return e
  return null
}

/**
 * Fade multiplier (0..1) at clip-local timeline time `t` of a clip lasting
 * `dur` timeline seconds. Linear ramps; blocked edges are ignored.
 */
export function fadeGain(
  fade: Pick<FadeEffect, 'in' | 'out'> | null,
  t: number,
  dur: number,
  edges: Partial<FadeEdges> = {},
): number {
  if (!fade) return 1
  let g = 1
  if (edges.fadeIn !== false && fade.in > 0) g = Math.min(g, clamp01(t / fade.in))
  if (edges.fadeOut !== false && fade.out > 0)
    g = Math.min(g, clamp01((dur - t) / fade.out))
  return g
}

/** Enabled zooms sorted by start, cached per (immutable) effects array. */
const zoomCache = new WeakMap<readonly ClipEffect[], ZoomEffect[]>()
function sortedZooms(effects: readonly ClipEffect[]): ZoomEffect[] {
  let list = zoomCache.get(effects)
  if (!list) {
    list = effects
      .filter((e): e is ZoomEffect => e.type === 'zoom' && e.enabled)
      .sort((a, b) => a.start - b.start)
    zoomCache.set(effects, list)
  }
  return list
}

export interface ZoomState extends CropSample {
  /** 0 = not zoomed, 1 = fully at the segment's own zoom. */
  amount: number
  /** Mode of the segment being sampled. */
  mode: ZoomMode
}

function zoomTarget(z: ZoomEffect): ZoomState {
  return { scale: z.scale, fx: z.focusX, fy: z.focusY, amount: 1, mode: z.mode }
}

function mixZoom(a: ZoomState, b: ZoomState, p: number): ZoomState {
  return {
    scale: lerp(a.scale, b.scale, p),
    fx: lerp(a.fx, b.fx, p),
    fy: lerp(a.fy, b.fy, p),
    amount: lerp(a.amount, b.amount, p),
    mode: b.mode,
  }
}

/** Two zooms pan into each other only when adjacent AND of the same mode. */
function adjacent(a: ZoomEffect | undefined, b: ZoomEffect | undefined): boolean {
  return !!a && !!b && a.mode === b.mode && b.start - a.end <= ADJACENT_EPS
}

/**
 * Zoom state at source time `s`. Segments never overlap (the store rejects
 * that); ADJACENT ones (gap ≤ ADJACENT_EPS) pan from one focus to the next
 * over the second segment's ease-in instead of zooming out and back in.
 */
export function sampleZoom(zooms: readonly ZoomEffect[], s: number): ZoomState | null {
  for (let i = 0; i < zooms.length; i++) {
    const z = zooms[i]!
    const next = zooms[i + 1]
    const nextAdj = adjacent(z, next)
    if (s < z.start) return null // sorted: nothing earlier can contain s
    if (s >= z.end) {
      // Hold through a tiny gap between adjacent segments.
      if (nextAdj && next && s < next.start) return zoomTarget(z)
      continue
    }
    const prev = zooms[i - 1]
    const prevAdj = adjacent(prev, z)
    const len = z.end - z.start
    let ein = z.easeIn
    let eout = nextAdj ? 0 : z.easeOut
    if (ein + eout > len && ein + eout > 0) {
      const k = len / (ein + eout)
      ein *= k
      eout *= k
    }
    const target = zoomTarget(z)
    if (ein > 0 && s < z.start + ein) {
      const p = ease((s - z.start) / ein, 'ease-in-out')
      const from: ZoomState =
        prevAdj && prev
          ? zoomTarget(prev)
          : { scale: 1, fx: z.focusX, fy: z.focusY, amount: 0, mode: z.mode }
      return mixZoom(from, target, p)
    }
    if (eout > 0 && s > z.end - eout) {
      const p = ease((z.end - s) / eout, 'ease-in-out')
      return mixZoom(
        { scale: 1, fx: z.focusX, fy: z.focusY, amount: 0, mode: z.mode },
        target,
        p,
      )
    }
    return target
  }
  return null
}

/** 0→1→0 envelope over [start, end) with `ramp`-second edges. */
function envelope(s: number, start: number, end: number, ramp: number): number {
  if (s < start || s >= end) return 0
  const r = Math.min(ramp, (end - start) / 4)
  if (r <= 0) return 1
  return Math.min(1, (s - start) / r, (end - s) / r)
}

/**
 * Sample every effect of `clip`. `clipLocalT` = timeline time − clip start;
 * `sourceT` = the (clamped) source time shown, see clipSourceTime.
 */
export function sampleEffects(
  clip: Clip,
  clipLocalT: number,
  sourceT: number,
  opts: SampleOptions = {},
): EffectSample {
  const effects = clip.effects
  if (!effects || effects.length === 0) return IDENTITY

  const camera = !opts.suppressCamera
  let crop: CropSample = IDENTITY_CROP
  let grow: CropSample | null = null
  let frame: CropSample | null = null
  let opacityMul = 1
  let shake: ShakeSample | null = null
  let spotlight: SpotlightSample | null = null
  let chroma: ChromaSample | null = null
  let fade: FadeEffect | null = null
  let kb: CropSample | null = null

  for (const e of effects) {
    if (!e.enabled) continue
    switch (e.type) {
      case 'fade':
        fade ??= e
        break
      case 'kenBurns': {
        if (!camera || kb) break
        const dur = clipLength(clip)
        const p = dur > 0 ? clamp01(clipLocalT / dur) : 0
        kb = {
          scale: lerp(e.fromScale, e.toScale, p),
          fx: lerp(e.fromX, e.toX, p),
          fy: lerp(e.fromY, e.toY, p),
        }
        break
      }
      case 'spotlight': {
        if (!camera || spotlight) break
        const k = envelope(sourceT, e.start, e.end, SPOTLIGHT_RAMP)
        if (k <= 0) break
        spotlight = {
          x: e.x,
          y: e.y,
          w: e.w,
          h: e.h,
          shape: e.shape,
          dim: e.dim * k,
          blur: e.blur * k,
          feather: e.feather,
        }
        break
      }
      case 'shake': {
        if (!camera) break
        const k = envelope(sourceT, e.start, e.end, SHAKE_RAMP)
        if (k <= 0 || e.intensity <= 0) break
        const amp = e.intensity * k
        const n = shakeOffset(e.id, sourceT, e.frequency)
        shake = shake
          ? { dx: shake.dx + n.x * amp, dy: shake.dy + n.y * amp, amp: shake.amp + amp }
          : { dx: n.x * amp, dy: n.y * amp, amp }
        break
      }
      case 'chromaKey':
        chroma ??= chromaOf(e)
        break
      case 'zoom':
        break // handled below (needs all segments)
    }
  }

  if (camera) {
    const sampled = sampleZoom(sortedZooms(effects), sourceT)
    // 'grow' / 'frame' zooms scale the object / the composition instead of
    // the picture inside the frame; only 'inside' zooms feed the crop.
    let z: ZoomState | null = sampled
    if (sampled && sampled.mode !== 'inside') {
      const v: CropSample = { scale: sampled.scale, fx: sampled.fx, fy: sampled.fy }
      if (sampled.mode === 'grow') grow = v
      else frame = v
      z = null
    }
    if (z && kb) {
      // Zoom on top of Ken Burns: scales multiply; the focus moves from the
      // Ken Burns framing to the zoom target as the zoom comes in.
      crop = {
        scale: kb.scale * z.scale,
        fx: lerp(kb.fx, z.fx, z.amount),
        fy: lerp(kb.fy, z.fy, z.amount),
      }
    } else if (z) {
      // Zoom straight into the focus point (the crop clamp keeps it in frame).
      crop = { scale: z.scale, fx: z.fx, fy: z.fy }
    } else if (kb) {
      crop = kb
    }
  }

  if (fade) opacityMul = fadeGain(fade, clipLocalT, clipLength(clip), opts)

  return {
    crop,
    grow,
    frame,
    opacityMul,
    volumeMul: opacityMul,
    shake,
    spotlight,
    chroma,
  }
}

function chromaOf(e: ChromaKeyEffect): ChromaSample {
  return {
    color: e.color,
    similarity: e.similarity,
    smoothness: e.smoothness,
    spill: e.spill,
  }
}

/** Source rectangle for the 9-argument drawImage. */
export interface SourceRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Source crop for media of `srcW`×`srcH` drawn into a `boxW`×`boxH` box.
 * `sw = srcW / scale`, `sx = clamp(fx·srcW − sw/2, 0, srcW − sw)`, so the
 * viewport never leaves the frame (no black edges). Shake jitters the
 * viewport and forces a minimum zoom of `1 + 2·amp/box` so there is always
 * room to move.
 *
 * With a user crop, `region` is the kept part of the source (pixels): the
 * zoom then works inside it — `fx`, `fy` are fractions of the region and
 * the viewport never leaves it.
 */
export function computeCrop(
  sample: Pick<EffectSample, 'crop' | 'shake'>,
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
  region?: SourceRect,
): SourceRect {
  const { crop, shake } = sample
  const r = region ?? { sx: 0, sy: 0, sw: srcW, sh: srcH }
  let scale = Math.max(1, crop.scale)
  if (shake && shake.amp > 0) {
    const minZoom = 1 + (2 * shake.amp) / Math.max(1, Math.min(boxW, boxH))
    scale = Math.max(scale, minZoom)
  }
  const sw = r.sw / scale
  const sh = r.sh / scale
  let cx = r.sx + crop.fx * r.sw
  let cy = r.sy + crop.fy * r.sh
  if (shake) {
    // Box px → source px.
    cx += shake.dx * (sw / Math.max(1, boxW))
    cy += shake.dy * (sh / Math.max(1, boxH))
  }
  return {
    sx: clamp(cx - sw / 2, r.sx, r.sx + r.sw - sw),
    sy: clamp(cy - sh / 2, r.sy, r.sy + r.sh - sh),
    sw,
    sh,
  }
}

/** True when the sample changes the picture geometry (crop needed). */
export function needsCrop(sample: Pick<EffectSample, 'crop' | 'shake'>): boolean {
  return sample.crop.scale > 1.0001 || !!sample.shake
}
