/**
 * Clip effects: a discriminated union stored on `Clip.effects`.
 *
 * Timing conventions (see the effects plan):
 *  - zoom / spotlight / shake: `start`/`end` are SOURCE seconds, so they stay
 *    anchored to the content through trim, speed changes, split, silence
 *    removal and duplicate. Out-of-range effects are kept but never shown.
 *  - fade: `in`/`out` are durations in TIMELINE seconds from the clip edges.
 *  - kenBurns: driven by normalized clip progress (0 → 1).
 *  - chromaKey: no timing (whole clip). Rendered from Phase 2 on.
 */
import type { ID, MediaSource } from '../timeline/types'
import { clamp } from './easing'

interface EffectBase {
  id: ID
  enabled: boolean
}

/**
 * How a zoom enlarges things:
 *  - 'inside': zoom INTO the clip's picture; its frame stays the same size
 *    (Screen-Studio style, best for full-screen recordings).
 *  - 'grow':   the object itself gets bigger on screen, around the focus point
 *    (webcam bubble, image, element, text).
 *  - 'frame':  the whole video zooms in, centred on the focus point of this
 *    object (everything gets bigger, framing the object).
 */
export type ZoomMode = 'inside' | 'grow' | 'frame'

export const ZOOM_MODES: readonly ZoomMode[] = ['inside', 'grow', 'frame']

export interface ZoomEffect extends EffectBase {
  type: 'zoom'
  mode: ZoomMode
  /** Source seconds. */
  start: number
  end: number
  /** Zoom level, ≥ 1 (2 = twice as close). */
  scale: number
  /** Focus point in source-normalized coordinates (0..1). */
  focusX: number
  focusY: number
  /** Ramp durations in source seconds. */
  easeIn: number
  easeOut: number
}

export interface KenBurnsEffect extends EffectBase {
  type: 'kenBurns'
  fromScale: number
  toScale: number
  /** Viewport centre at the clip start / end (source-normalized). */
  fromX: number
  fromY: number
  toX: number
  toY: number
}

export interface FadeEffect extends EffectBase {
  type: 'fade'
  /** Timeline seconds from the clip start (0 = no fade in). */
  in: number
  /** Timeline seconds before the clip end (0 = no fade out). */
  out: number
}

export type SpotlightShape = 'rect' | 'ellipse'

export interface SpotlightEffect extends EffectBase {
  type: 'spotlight'
  /** Source seconds. */
  start: number
  end: number
  /** Highlighted area: top-left corner + size, source-normalized (0..1). */
  x: number
  y: number
  w: number
  h: number
  shape: SpotlightShape
  /** How much the rest of the frame is darkened (0..1). */
  dim: number
  /** Blur of the rest of the frame (project px). */
  blur: number
  /** Edge softness relative to the shape size (0..1). */
  feather: number
}

export interface ShakeEffect extends EffectBase {
  type: 'shake'
  /** Source seconds. */
  start: number
  end: number
  /** Max offset in project px. */
  intensity: number
  /** Wobbles per second. */
  frequency: number
}

export interface ChromaKeyEffect extends EffectBase {
  type: 'chromaKey'
  /** Key colour, '#rrggbb'. */
  color: string
  similarity: number
  smoothness: number
  spill: number
}

export type ClipEffect =
  | ZoomEffect
  | KenBurnsEffect
  | FadeEffect
  | SpotlightEffect
  | ShakeEffect
  | ChromaKeyEffect

export type EffectType = ClipEffect['type']

/** Effects with a [start, end) range in source seconds. */
export type RangedEffect = ZoomEffect | SpotlightEffect | ShakeEffect

/** A patch for one effect: any subset of its own fields (not id/type). */
export type EffectPatch = {
  [K in EffectType]: Partial<Omit<Extract<ClipEffect, { type: K }>, 'id' | 'type'>>
}[EffectType]

export const EFFECT_LABELS: Record<EffectType, string> = {
  zoom: 'Zoom',
  kenBurns: 'Ken Burns',
  fade: 'Fade in / out',
  spotlight: 'Spotlight',
  shake: 'Camera shake',
  chromaKey: 'Chroma key',
}

/** Shortest allowed range for a ranged effect (source seconds). */
export const MIN_EFFECT_LEN = 0.1
export const MAX_ZOOM = 8
export const MAX_FADE = 30
export const MAX_SHAKE_INTENSITY = 200
export const MAX_SPOTLIGHT_BLUR = 100
/** Two zoom segments closer than this (source s) count as adjacent. */
export const ADJACENT_EPS = 0.05

export function isRangedEffect(e: ClipEffect): e is RangedEffect {
  return e.type === 'zoom' || e.type === 'spotlight' || e.type === 'shake'
}

/**
 * Effects that crop/mask the media itself; not offered for text/elements.
 * (Zoom is allowed there in its 'grow' / 'frame' modes, see zoomModesFor.)
 */
export function isCropEffectType(type: EffectType): boolean {
  return type === 'kenBurns' || type === 'spotlight' || type === 'chromaKey'
}

/** Text, elements and shapes: objects without a picture to crop into. */
export function isObjectKind(kind: MediaSource['kind']): boolean {
  return kind === 'text' || kind === 'element' || kind === 'shape'
}

/** Zoom modes that make sense for a source kind ('inside' needs a picture). */
export function zoomModesFor(kind: MediaSource['kind']): readonly ZoomMode[] {
  if (kind === 'audio') return []
  if (isObjectKind(kind)) return ['grow', 'frame']
  return ZOOM_MODES
}

/** Default zoom mode: zoom into full-frame pictures, grow overlays/objects. */
export function defaultZoomMode(
  kind: MediaSource['kind'],
  onOverlayTrack: boolean,
): ZoomMode {
  if (isObjectKind(kind)) return 'grow'
  return onOverlayTrack ? 'grow' : 'inside'
}

/** Whether `type` can be applied to a clip of `kind`. */
export function effectAllowedFor(type: EffectType, kind: MediaSource['kind']): boolean {
  if (kind === 'audio') return type === 'fade'
  if (isObjectKind(kind)) return !isCropEffectType(type)
  return true
}

let counter = 0
export function newEffectId(): ID {
  counter = (counter + 1) % 1_000_000
  return `fx${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

// ── Factories (defaults) ────────────────────────────────────────────────────

export function createZoom(
  start: number,
  end: number,
  p?: Partial<ZoomEffect>,
): ZoomEffect {
  return normalizeEffect({
    id: newEffectId(),
    type: 'zoom',
    enabled: true,
    mode: 'inside',
    start,
    end,
    scale: 2,
    focusX: 0.5,
    focusY: 0.5,
    easeIn: 0.5,
    easeOut: 0.5,
    ...p,
  })
}

export function createKenBurns(p?: Partial<KenBurnsEffect>): KenBurnsEffect {
  return normalizeEffect({
    id: newEffectId(),
    type: 'kenBurns',
    enabled: true,
    fromScale: 1,
    toScale: 1.25,
    fromX: 0.5,
    fromY: 0.5,
    toX: 0.55,
    toY: 0.45,
    ...p,
  })
}

export function createFade(p?: Partial<FadeEffect>): FadeEffect {
  return normalizeEffect({
    id: newEffectId(),
    type: 'fade',
    enabled: true,
    in: 0.5,
    out: 0.5,
    ...p,
  })
}

export function createSpotlight(
  start: number,
  end: number,
  p?: Partial<SpotlightEffect>,
): SpotlightEffect {
  return normalizeEffect({
    id: newEffectId(),
    type: 'spotlight',
    enabled: true,
    start,
    end,
    x: 0.3,
    y: 0.3,
    w: 0.4,
    h: 0.4,
    shape: 'ellipse',
    dim: 0.6,
    blur: 8,
    feather: 0.2,
    ...p,
  })
}

export function createShake(
  start: number,
  end: number,
  p?: Partial<ShakeEffect>,
): ShakeEffect {
  return normalizeEffect({
    id: newEffectId(),
    type: 'shake',
    enabled: true,
    start,
    end,
    intensity: 12,
    frequency: 8,
    ...p,
  })
}

export function createChromaKey(p?: Partial<ChromaKeyEffect>): ChromaKeyEffect {
  return normalizeEffect({
    id: newEffectId(),
    type: 'chromaKey',
    enabled: true,
    color: '#00ff00',
    similarity: 0.4,
    smoothness: 0.08,
    spill: 0.1,
    ...p,
  })
}

// ── Normalization ───────────────────────────────────────────────────────────

const fin = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback)
const unit = (v: number, fallback: number) => clamp(fin(v, fallback), 0, 1)

/** Normalize a [start, end) source range: finite, ≥ 0, at least MIN_EFFECT_LEN. */
function range(start: number, end: number): { start: number; end: number } {
  const s = Math.max(0, fin(start, 0))
  const e = Math.max(s + MIN_EFFECT_LEN, fin(end, s + MIN_EFFECT_LEN))
  return { start: s, end: e }
}

/**
 * Clamp every field of an effect to its valid range (returns a new object).
 * Used by the store after each edit and by the project schema on load.
 */
export function normalizeEffect<T extends ClipEffect>(e: T): T {
  return normalizeAny(e) as T
}

function normalizeAny(e: ClipEffect): ClipEffect {
  switch (e.type) {
    case 'zoom': {
      const r = range(e.start, e.end)
      const len = r.end - r.start
      return {
        ...e,
        ...r,
        mode: ZOOM_MODES.includes(e.mode) ? e.mode : 'inside',
        scale: clamp(fin(e.scale, 2), 1, MAX_ZOOM),
        focusX: unit(e.focusX, 0.5),
        focusY: unit(e.focusY, 0.5),
        easeIn: clamp(fin(e.easeIn, 0.5), 0, len),
        easeOut: clamp(fin(e.easeOut, 0.5), 0, len),
      }
    }
    case 'kenBurns':
      return {
        ...e,
        fromScale: clamp(fin(e.fromScale, 1), 1, MAX_ZOOM),
        toScale: clamp(fin(e.toScale, 1), 1, MAX_ZOOM),
        fromX: unit(e.fromX, 0.5),
        fromY: unit(e.fromY, 0.5),
        toX: unit(e.toX, 0.5),
        toY: unit(e.toY, 0.5),
      }
    case 'fade':
      return {
        ...e,
        in: clamp(fin(e.in, 0), 0, MAX_FADE),
        out: clamp(fin(e.out, 0), 0, MAX_FADE),
      }
    case 'spotlight': {
      const w = clamp(fin(e.w, 0.4), 0.02, 1)
      const h = clamp(fin(e.h, 0.4), 0.02, 1)
      return {
        ...e,
        ...range(e.start, e.end),
        w,
        h,
        x: clamp(fin(e.x, 0.3), 0, 1 - w),
        y: clamp(fin(e.y, 0.3), 0, 1 - h),
        shape: e.shape === 'rect' ? 'rect' : 'ellipse',
        dim: unit(e.dim, 0.6),
        blur: clamp(fin(e.blur, 0), 0, MAX_SPOTLIGHT_BLUR),
        feather: unit(e.feather, 0.2),
      }
    }
    case 'shake':
      return {
        ...e,
        ...range(e.start, e.end),
        intensity: clamp(fin(e.intensity, 12), 0, MAX_SHAKE_INTENSITY),
        frequency: clamp(fin(e.frequency, 8), 0.1, 60),
      }
    case 'chromaKey':
      return {
        ...e,
        color: /^#[0-9a-f]{6}$/i.test(e.color) ? e.color.toLowerCase() : '#00ff00',
        similarity: unit(e.similarity, 0.4),
        smoothness: unit(e.smoothness, 0.08),
        spill: unit(e.spill, 0.1),
      }
  }
}
