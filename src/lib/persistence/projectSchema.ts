/**
 * Zod schema for the Project type.
 *
 * Validates structure (required fields, enums, types) and strips unknown keys
 * so a corrupted or future-versioned file never crashes the app at runtime.
 * Any structural failure throws a ZodError whose `.message` is safe to show.
 *
 * Values a user can edit are *repaired*, not rejected: out-of-range numbers
 * are clamped and `null` numbers (what JSON.stringify writes for NaN and
 * Infinity) fall back to a default. One stray float must never make a whole
 * project unopenable.
 */
import { z } from 'zod'
import { normalizeEffect, type ClipEffect } from '../effects/types'
import { normalizeCrop } from '../layout/placement'
import { BLEND_MODES } from '../timeline/types'
import { normalizeShape } from '../shapes'

/** Number clamped to [min, max]; `null` (serialized NaN/Infinity) → fallback. */
/** `schema`, but a non-number or non-finite value becomes `fallback` first. */
function missingAs<T extends z.ZodType>(fallback: number, schema: T) {
  return z.preprocess(
    (v) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback),
    schema,
  )
}

function num(fallback: number, min = -Infinity, max = Infinity) {
  return z
    .preprocess((v) => (v === null ? fallback : v), z.number())
    .transform((v) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback))
}

/** Optional number clamped to >= min; `null` is treated as absent. */
function optNum(min = -Infinity) {
  return z
    .preprocess((v) => (v === null ? undefined : v), z.number().optional())
    .transform((v) =>
      v === undefined || !Number.isFinite(v) ? undefined : Math.max(min, v),
    )
}

/** Optional number clamped to [min, max]; `null` / non-finite → absent. */
function optRange(min: number, max: number) {
  return z
    .preprocess((v) => (v === null ? undefined : v), z.number().optional())
    .transform((v) =>
      v === undefined || !Number.isFinite(v)
        ? undefined
        : Math.min(max, Math.max(min, v)),
    )
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const TransformSchema = z.object({
  x: num(0),
  y: num(0),
  scaleX: num(1),
  scaleY: num(1),
  rotation: num(0),
  opacity: num(1, 0, 1),
  anchorX: optRange(0, 1),
  anchorY: optRange(0, 1),
  lockAspect: z.boolean().optional().catch(undefined),
})

/** User crop: clamped to the allowed range; an empty / broken crop → absent. */
const CropSchema = z
  .object({
    left: num(0, 0, 1),
    top: num(0, 0, 1),
    right: num(0, 0, 1),
    bottom: num(0, 0, 1),
  })
  .transform((c) => normalizeCrop(c))

const ColorAdjustSchema = z.object({
  brightness: num(1, 0),
  contrast: num(1, 0),
  saturation: num(1, 0),
  hue: num(0, -360, 360),
  blur: num(0, 0),
})

const EasingSchema = z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out'])

const KeyframeSchema = z.object({
  t: num(0, 0),
  value: num(0),
  easing: EasingSchema.optional(),
})

const KeyframePropSchema = z.enum([
  'opacity',
  'volume',
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
])

const TextStyleSchema = z.object({
  content: z.string(),
  fontFamily: z.string(),
  fontSize: num(72, 1, 1000),
  fontWeight: num(700, 1, 1000),
  color: z.string(),
  background: z.string().optional(),
  align: z.enum(['left', 'center', 'right']),
  strokeColor: z.string().optional(),
  strokeWidth: optNum(0),
  shadow: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  letterSpacing: optNum(),
  lineHeight: optNum(0),
  boxWidth: optNum(0),
  backgroundOpacity: optNum(0),
  backgroundPadding: optNum(0),
  backgroundRadius: optNum(0),
  shadowColor: z.string().optional(),
  shadowBlur: optNum(0),
  shadowOffsetX: optNum(),
  shadowOffsetY: optNum(),
})

/** Source kinds this version understands. Others are dropped on load. */
const SOURCE_KINDS = [
  'video',
  'audio',
  'image',
  'text',
  'animation',
  'element',
  'shape',
] as const

const AnimationInfoSchema = z.object({
  format: z.enum(['lottie', 'gif', 'webp', 'apng', 'avif']),
  fps: optNum(0),
  frameCount: num(1, 1),
  loop: z.boolean(),
})

const ElementInfoSchema = z.object({
  template: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
})

const ShapeInfoSchema = z
  .object({
    type: z.enum(['rect', 'ellipse', 'line', 'arrow']),
    fill: z.string(),
    stroke: z.string(),
    strokeWidth: num(0, 0),
    radius: num(0, 0),
    width: num(100, 1),
    height: num(100, 1),
  })
  .transform((s) => normalizeShape(s))

export const MediaSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(SOURCE_KINDS),
  opfsPath: z.string(),
  mimeType: z.string(),
  duration: num(0, 0),
  width: optNum(0),
  height: optNum(0),
  sampleRate: optNum(0),
  createdAt: num(0, 0),
  name: z.string(),
  text: TextStyleSchema.optional(),
  importKey: z.string().optional(),
  captionFor: z.string().optional(),
  diskPath: z.string().optional(),
  hasAlpha: z.boolean().optional(),
  fullFrame: z.boolean().optional(),
  // Optional metadata from newer features: a malformed block is dropped
  // rather than failing the whole source.
  animation: AnimationInfoSchema.optional().catch(undefined),
  element: ElementInfoSchema.optional().catch(undefined),
  shape: ShapeInfoSchema.optional().catch(undefined),
})

const TranscriptSchema = z.object({
  model: z.string(),
  language: z.string(),
  createdAt: num(0, 0),
  segments: z.array(
    z.object({
      start: num(0, 0),
      end: num(0, 0),
      text: z.string(),
    }),
  ),
})

// ── Effects ────────────────────────────────────────────────────────────────
// Validated one by one: an unknown (newer) or malformed effect is dropped,
// never the clip or the project. Values are then clamped by normalizeEffect.

const effectBase = { id: z.string().min(1), enabled: z.boolean().catch(true) }

const EffectSchema = z.discriminatedUnion('type', [
  z.object({
    ...effectBase,
    type: z.literal('zoom'),
    // Projects saved before zoom modes existed zoomed inside the frame.
    mode: z.enum(['inside', 'grow', 'frame']).catch('inside'),
    start: num(0, 0),
    end: num(0, 0),
    scale: num(2, 1),
    focusX: num(0.5, 0, 1),
    focusY: num(0.5, 0, 1),
    easeIn: num(0.5, 0),
    easeOut: num(0.5, 0),
  }),
  z.object({
    ...effectBase,
    type: z.literal('kenBurns'),
    fromScale: num(1, 1),
    toScale: num(1, 1),
    fromX: num(0.5, 0, 1),
    fromY: num(0.5, 0, 1),
    toX: num(0.5, 0, 1),
    toY: num(0.5, 0, 1),
  }),
  z.object({
    ...effectBase,
    type: z.literal('fade'),
    in: num(0, 0),
    out: num(0, 0),
  }),
  z.object({
    ...effectBase,
    type: z.literal('spotlight'),
    start: num(0, 0),
    end: num(0, 0),
    x: num(0.3, 0, 1),
    y: num(0.3, 0, 1),
    w: num(0.4, 0, 1),
    h: num(0.4, 0, 1),
    shape: z.enum(['rect', 'ellipse']).catch('ellipse'),
    dim: num(0.6, 0, 1),
    blur: num(0, 0),
    feather: num(0.2, 0, 1),
  }),
  z.object({
    ...effectBase,
    type: z.literal('shake'),
    start: num(0, 0),
    end: num(0, 0),
    intensity: num(12, 0),
    frequency: num(8, 0.1),
  }),
  z.object({
    ...effectBase,
    type: z.literal('chromaKey'),
    color: z.string(),
    similarity: num(0.4, 0, 1),
    smoothness: num(0.08, 0, 1),
    spill: num(0.1, 0, 1),
  }),
])

const EffectsSchema = z.array(z.unknown()).transform((items) => {
  const out: ClipEffect[] = []
  const ids = new Set<string>()
  for (const item of items) {
    const r = EffectSchema.safeParse(item)
    if (!r.success || ids.has(r.data.id)) continue
    ids.add(r.data.id)
    out.push(normalizeEffect(r.data as ClipEffect))
  }
  return out
})

export const ClipSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  sourceId: z.string().min(1),
  timelineStart: num(0, 0),
  sourceIn: num(0, 0),
  sourceOut: num(0, 0),
  /** Clamp speed to a safe operating range — prevents division-by-zero. */
  speed: num(1, 0.1, 16),
  transform: TransformSchema,
  volume: num(1, 0, 4),
  // `partialRecord` (not `record`): keyframes are Partial<Record<KeyframeProp, …>>,
  // so only the props the user actually animated are present. Plain `z.record`
  // over an enum key is EXHAUSTIVE in Zod v4 and would reject any clip that
  // keyframes fewer than all seven props — silently failing to reload the file.
  keyframes: z.partialRecord(KeyframePropSchema, z.array(KeyframeSchema)).optional(),
  color: ColorAdjustSchema.optional(),
  linkGroup: z.string().optional(),
  isLive: z.boolean().optional(),
  // A non-array is treated as "no effects" rather than a broken clip.
  effects: EffectsSchema.optional().catch(undefined),
  loop: z.boolean().optional(),
  crop: CropSchema.optional().catch(undefined),
  // An unknown (newer) blend mode falls back to normal.
  blendMode: z.enum(BLEND_MODES).optional().catch(undefined),
})

const TrackSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'audio', 'overlay', 'text']),
  name: z.string(),
  muted: z.boolean(),
  solo: z.boolean().optional(),
  locked: z.boolean(),
  hidden: z.boolean().optional(),
  height: num(48, 20, 600),
  role: z.enum(['screen', 'webcam', 'system-audio', 'mic', 'captions']).optional(),
})

const TransitionKindSchema = z.enum([
  'crossfade',
  'dip-black',
  'dip-white',
  'wipe-left',
  'wipe-right',
  'wipe-up',
  'wipe-down',
  'slide-left',
  'slide-right',
])

const TransitionSchema = z.object({
  id: z.string().min(1),
  fromClipId: z.string().min(1),
  toClipId: z.string().min(1),
  kind: TransitionKindSchema,
  duration: num(0.5, 0, 30),
})

const MarkerSchema = z.object({
  id: z.string().min(1),
  time: num(0, 0),
  label: z.string(),
  color: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Root Project schema
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Drop sources whose `kind` this version doesn't know (written by a newer
 * app), together with their clips and the transitions touching those clips,
 * so such a project still opens with everything else intact.
 */
function dropUnknownSourceKinds(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) return raw
  const known = new Set<string>(SOURCE_KINDS)
  const dropped = new Set<unknown>()
  const sources = raw.sources.filter((src) => {
    if (isRecord(src) && typeof src.kind === 'string' && !known.has(src.kind)) {
      dropped.add(src.id)
      return false
    }
    return true
  })
  if (dropped.size === 0) return raw
  const removedClips = new Set<unknown>()
  const clips = Array.isArray(raw.clips)
    ? raw.clips.filter((c) => {
        if (isRecord(c) && dropped.has(c.sourceId)) {
          removedClips.add(c.id)
          return false
        }
        return true
      })
    : raw.clips
  const transitions = Array.isArray(raw.transitions)
    ? raw.transitions.filter(
        (t) =>
          !(
            isRecord(t) &&
            (removedClips.has(t.fromClipId) || removedClips.has(t.toClipId))
          ),
      )
    : raw.transitions
  return { ...raw, sources, clips, transitions }
}

const ProjectObjectSchema = z.object({
  id: z.string().min(1),
  // An empty name is legal in the editor (the user cleared the field).
  name: z.string().transform((v) => v.trim() || 'Untitled Project'),
  // Project format: a missing / non-finite value (JSON writes NaN as null)
  // falls back to the default like every other number here, but an
  // out-of-range one means the file is corrupt and is rejected.
  fps: missingAs(30, z.number().min(1).max(240)),
  width: missingAs(1920, z.number().int().min(1).max(7680)),
  height: missingAs(1080, z.number().int().min(1).max(7680)),
  sampleRate: missingAs(48000, z.number().min(1).max(384000)),
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
  transitions: z.array(TransitionSchema),
  markers: z.array(MarkerSchema).optional(),
  sources: z.array(MediaSourceSchema),
  transcripts: z.record(z.string(), TranscriptSchema).optional(),
  duration: num(0, 0),
  createdAt: num(0, 0),
  updatedAt: num(0, 0),
})

export const ProjectSchema = z.preprocess(dropUnknownSourceKinds, ProjectObjectSchema)

export type ValidatedProject = z.output<typeof ProjectSchema>
