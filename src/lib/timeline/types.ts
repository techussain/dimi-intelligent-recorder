import type { ClipEffect } from '../effects/types'

export type ID = string

export type { ClipEffect }

export type TrackKind = 'video' | 'audio' | 'overlay' | 'text'

export interface MediaSource {
  id: ID
  /**
   * 'animation' (Lottie / animated GIF·WebP·APNG), 'element' (built-in
   * vector overlays) and 'shape' (vector rectangle / ellipse / line / arrow).
   * Text, element and shape sources belong to one clip each (no file).
   */
  kind: 'video' | 'audio' | 'image' | 'text' | 'animation' | 'element' | 'shape'
  /** OPFS path relative to the project root. Empty for text / element / shape sources. */
  opfsPath: string
  mimeType: string
  /** Duration in seconds. 0 for still images / default for text. */
  duration: number
  width?: number | undefined
  height?: number | undefined
  sampleRate?: number | undefined
  /** Created timestamp (ms). */
  createdAt: number
  /** Display name in library. */
  name: string
  /** Text content + style (when kind === 'text'). */
  text?: TextStyle
  /**
   * Fingerprint of the imported file (name|size|lastModified), used to skip
   * re-importing the same file. Absent for recordings and text.
   */
  importKey?: string
  /**
   * Set on text sources generated as captions: the source whose transcript
   * they come from. Such sources are hidden from the Media Library.
   */
  captionFor?: ID
  /**
   * Absolute path of the real file on the user's disk (desktop app only): the
   * copy saved in the recordings folder for recordings / merged clips, or the
   * original file for imports. Used to restore the OPFS copy if it is lost.
   * File metadata: set via updateSource without an undo step.
   */
  diskPath?: string
  /** Video with an alpha channel (e.g. VP9-alpha WebM). */
  hasAlpha?: boolean
  /**
   * The picture is a full frame of the project (a merged composite), so it is
   * fitted to the whole frame even on an overlay track — not shrunk into the
   * bottom-right picture-in-picture box overlays normally get.
   */
  fullFrame?: boolean
  /** Set when kind === 'animation'. */
  animation?: AnimationInfo
  /** Set when kind === 'element'. */
  element?: ElementInfo
  /** Set when kind === 'shape'. */
  shape?: ShapeInfo
}

export type ShapeType = 'rect' | 'ellipse' | 'line' | 'arrow'

/**
 * A vector shape (see lib/shapes). Sizes are intrinsic px authored for a
 * 1080p frame, scaled with the project like elements. Lines and arrows run
 * horizontally across the box centre and use only the stroke.
 */
export interface ShapeInfo {
  type: ShapeType
  /** CSS colour; 'transparent' = no fill. */
  fill: string
  stroke: string
  /** Stroke width, intrinsic px (0 = no outline for rect / ellipse). */
  strokeWidth: number
  /** Corner radius of a rect, intrinsic px. */
  radius: number
  width: number
  height: number
}

export interface AnimationInfo {
  format: 'lottie' | 'gif' | 'webp' | 'apng' | 'avif'
  /** Native frame rate, when the format has one (Lottie). */
  fps?: number
  frameCount: number
  /** Whether the asset itself loops. */
  loop: boolean
}

export interface ElementInfo {
  /** Template id from the Elements pack. */
  template: string
  /** Editable parameters (text, colours, …). */
  params: Record<string, string | number | boolean>
}

/** One transcribed phrase. Times are in the media file's seconds (source time). */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

/** Speech-to-text result for one media source. */
export interface Transcript {
  /** Model id used, e.g. 'onnx-community/whisper-base.en'. */
  model: string
  /** BCP-47-ish language code, e.g. 'en'. */
  language: string
  createdAt: number
  segments: TranscriptSegment[]
}

export interface TextStyle {
  content: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  color: string
  background?: string | undefined
  align: 'left' | 'center' | 'right'
  strokeColor?: string | undefined
  strokeWidth?: number | undefined
  shadow?: boolean | undefined
  // Formatting (all optional; defaults and limits in src/lib/text/style.ts).
  italic?: boolean | undefined
  underline?: boolean | undefined
  /** Extra space between letters, em. */
  letterSpacing?: number | undefined
  /** Line height, × font size (default 1.2). */
  lineHeight?: number | undefined
  /** Wrap width in project px; unset = no wrapping. */
  boxWidth?: number | undefined
  backgroundOpacity?: number | undefined
  /** Background padding, em (× font size). */
  backgroundPadding?: number | undefined
  /** Background corner radius, project px. */
  backgroundRadius?: number | undefined
  shadowColor?: string | undefined
  shadowBlur?: number | undefined
  shadowOffsetX?: number | undefined
  shadowOffsetY?: number | undefined
}

export const defaultTextStyle: TextStyle = {
  content: 'Sample text',
  fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
  fontSize: 72,
  fontWeight: 700,
  color: '#ffffff',
  align: 'center',
  strokeColor: '#000000',
  strokeWidth: 2,
  shadow: true,
}

/**
 * Clip transform (project px / degrees). Placement, see layout/placement.ts:
 * the unscaled, unrotated box sits at its base position + (x, y); scale and
 * rotation then apply about the anchor point. A negative scale mirrors.
 */
export interface Transform {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
  opacity: number
  /**
   * Anchor point (rotation / scale pivot) as a fraction of the object's
   * (cropped) box, 0..1; absent = 0.5 (centre). Not keyframable.
   */
  anchorX?: number | undefined
  anchorY?: number | undefined
  /** Width / height edits keep the aspect ratio. Absent = true. */
  lockAspect?: boolean | undefined
}

/**
 * User crop of a picture (video / image / animation): fractions of the
 * source removed from each edge, each 0..0.95 with left + right <= 0.95 and
 * top + bottom <= 0.95. See layout/placement.ts.
 */
export interface ClipCrop {
  left: number
  top: number
  right: number
  bottom: number
}

export const identityTransform: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
}

/** Simple per-clip color adjustment (applied via CSS-filter-style pipeline). */
export interface ColorAdjust {
  brightness: number // 1 = unchanged
  contrast: number // 1 = unchanged
  saturation: number // 1 = unchanged
  hue: number // degrees, 0 = unchanged
  blur: number // pixels, 0 = off
}

export const identityColor: ColorAdjust = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  blur: 0,
}

/** Per-layer blend modes (canvas `globalCompositeOperation` names). */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'soft-light',
  'hard-light',
  'difference',
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

export interface Keyframe<T = number> {
  t: number // seconds on clip-local timeline (0..clipDuration)
  value: T
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
}

export type KeyframeProp =
  | 'opacity'
  | 'volume'
  | 'x'
  | 'y'
  | 'scaleX'
  | 'scaleY'
  | 'rotation'

export interface Clip {
  id: ID
  trackId: ID
  sourceId: ID
  /** Where this clip starts on the master timeline (seconds). */
  timelineStart: number
  /** Trim-in within the source media (seconds). */
  sourceIn: number
  /** Trim-out within the source media (seconds). */
  sourceOut: number
  /** 1.0 = normal speed. */
  speed: number
  transform: Transform
  volume: number
  /** Per-property keyframes (clip-local seconds). */
  keyframes?: Partial<Record<KeyframeProp, Keyframe[]>>
  /** Color grading. Omitted = identity. */
  color?: ColorAdjust
  /** Group of linked clips (move/trim together). */
  linkGroup?: ID
  /** True while this clip is still being captured. */
  isLive?: boolean
  /** Visual / audio effects (zoom, fade, spotlight, …). See lib/effects. */
  effects?: ClipEffect[]
  /** Animation sources: keep looping past the asset's duration. */
  loop?: boolean
  /** Edges cropped off the picture (video / image / animation only). */
  crop?: ClipCrop | undefined
  /** How the layer blends with what is below it. Absent = 'normal'. */
  blendMode?: BlendMode | undefined
}

/** Built-in recording role — set on default project tracks so capture always
 *  lands on the right track regardless of track order or user-added tracks. */
export type TrackRole = 'screen' | 'webcam' | 'system-audio' | 'mic' | 'captions'

export interface Track {
  id: ID
  kind: TrackKind
  name: string
  muted: boolean
  solo?: boolean
  locked: boolean
  /** Hidden tracks are excluded from visual output but audio still plays. */
  hidden?: boolean
  height: number
  /** Designates a built-in recording track. User-created tracks have no role. */
  role?: TrackRole
}

export type TransitionKind =
  | 'crossfade'
  | 'dip-black'
  | 'dip-white'
  | 'wipe-left'
  | 'wipe-right'
  | 'wipe-up'
  | 'wipe-down'
  | 'slide-left'
  | 'slide-right'

export interface Transition {
  id: ID
  fromClipId: ID
  toClipId: ID
  kind: TransitionKind
  duration: number
}

export interface Marker {
  id: ID
  time: number
  label: string
  color?: string
}

export interface Project {
  id: ID
  name: string
  fps: number
  width: number
  height: number
  sampleRate: number
  tracks: Track[]
  clips: Clip[]
  transitions: Transition[]
  markers?: Marker[]
  sources: MediaSource[]
  /** Transcripts keyed by MediaSource id. */
  transcripts?: Record<ID, Transcript>
  duration: number
  createdAt: number
  updatedAt: number
}
