import type { TextStyle } from '../timeline/types'
import { normalizeFontFamily } from './fonts'

/**
 * Optional text-formatting fields on top of `TextStyle`. Every field is
 * optional so old projects (and the plain `TextStyle`) stay valid; missing
 * values resolve to the defaults below (see `resolveTextStyle`).
 *
 * Units: sizes are PROJECT pixels unless noted (like `fontSize`).
 */
export interface TextStyleExtras {
  italic?: boolean | undefined
  underline?: boolean | undefined
  /** Extra space after each character, in em (× fontSize). Default 0. */
  letterSpacing?: number | undefined
  /** Line height, × fontSize. Default 1.2. */
  lineHeight?: number | undefined
  /**
   * Width of the paragraph box in project px. When set, lines word-wrap to
   * it and the alignment applies inside it. Unset = no wrapping (lines only
   * break on explicit newlines).
   */
  boxWidth?: number | undefined
  /** Opacity of the background box, 0..1. Default 1. */
  backgroundOpacity?: number | undefined
  /**
   * Padding around the text inside the background box, in em (× fontSize):
   * this much left/right and half of it top/bottom (the line height already
   * adds vertical air). Default 0.2 (the pre-formatting look).
   */
  backgroundPadding?: number | undefined
  /** Corner radius of the background box in project px. Default 0. */
  backgroundRadius?: number | undefined
  /** Shadow colour (any CSS colour). Default rgba(0,0,0,0.55). */
  shadowColor?: string | undefined
  /** Shadow blur in project px. Default: max(2, 0.06 × fontSize). */
  shadowBlur?: number | undefined
  /** Shadow offset in project px. Default x 0, y max(1, 0.03 × fontSize). */
  shadowOffsetX?: number | undefined
  shadowOffsetY?: number | undefined
}

export type RichTextStyle = TextStyle & TextStyleExtras

/** A text style with every formatting value filled in and clamped. */
export interface ResolvedTextStyle {
  content: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  italic: boolean
  underline: boolean
  /** em */
  letterSpacing: number
  /** × fontSize */
  lineHeight: number
  /** project px, or null = no wrapping */
  boxWidth: number | null
  /** CSS colour, or null = no background */
  background: string | null
  backgroundOpacity: number
  /** em (horizontal; vertical is half) */
  backgroundPadding: number
  backgroundRadius: number
  /** CSS colour, or null = no stroke */
  strokeColor: string | null
  strokeWidth: number
  shadow: boolean
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
}

/** Ranges used by `resolveTextStyle` (and the Inspector controls). */
export const TEXT_LIMITS = {
  fontSize: { min: 4, max: 1000 },
  fontWeight: { min: 100, max: 900 },
  letterSpacing: { min: -0.5, max: 2 },
  lineHeight: { min: 0.5, max: 5 },
  boxWidth: { min: 20, max: 20000 },
  backgroundOpacity: { min: 0, max: 1 },
  backgroundPadding: { min: 0, max: 3 },
  backgroundRadius: { min: 0, max: 1000 },
  strokeWidth: { min: 0, max: 100 },
  shadowBlur: { min: 0, max: 200 },
  shadowOffset: { min: -500, max: 500 },
} as const

export const TEXT_DEFAULTS = {
  lineHeight: 1.2,
  letterSpacing: 0,
  backgroundOpacity: 1,
  backgroundPadding: 0.2,
  backgroundRadius: 0,
  shadowColor: 'rgba(0,0,0,0.55)',
} as const

/** Default shadow blur / y-offset for a font size (the pre-formatting look). */
export function defaultShadowBlur(fontSize: number): number {
  return Math.max(2, fontSize * 0.06)
}
export function defaultShadowOffsetY(fontSize: number): number {
  return Math.max(1, fontSize * 0.03)
}

function clampNum(
  v: number | undefined,
  range: { readonly min: number; readonly max: number },
  fallback: number,
): number {
  if (v === undefined || !Number.isFinite(v)) return fallback
  return Math.min(range.max, Math.max(range.min, v))
}

function nonEmpty(s: string | undefined): string | null {
  return typeof s === 'string' && s.trim() !== '' ? s : null
}

/** Fill in defaults and clamp every value to a sane range. Pure. */
export function resolveTextStyle(style: RichTextStyle): ResolvedTextStyle {
  const fontSize = clampNum(style.fontSize, TEXT_LIMITS.fontSize, 72)
  const strokeWidth = clampNum(style.strokeWidth, TEXT_LIMITS.strokeWidth, 0)
  const bw = style.boxWidth
  return {
    content: style.content,
    fontFamily: normalizeFontFamily(style.fontFamily),
    fontSize,
    fontWeight: Math.round(clampNum(style.fontWeight, TEXT_LIMITS.fontWeight, 400)),
    color: nonEmpty(style.color) ?? '#ffffff',
    align: style.align === 'left' || style.align === 'right' ? style.align : 'center',
    italic: style.italic === true,
    underline: style.underline === true,
    letterSpacing: clampNum(
      style.letterSpacing,
      TEXT_LIMITS.letterSpacing,
      TEXT_DEFAULTS.letterSpacing,
    ),
    lineHeight: clampNum(
      style.lineHeight,
      TEXT_LIMITS.lineHeight,
      TEXT_DEFAULTS.lineHeight,
    ),
    boxWidth:
      bw === undefined || !Number.isFinite(bw) || bw <= 0
        ? null
        : clampNum(bw, TEXT_LIMITS.boxWidth, TEXT_LIMITS.boxWidth.min),
    background: nonEmpty(style.background),
    backgroundOpacity: clampNum(
      style.backgroundOpacity,
      TEXT_LIMITS.backgroundOpacity,
      TEXT_DEFAULTS.backgroundOpacity,
    ),
    backgroundPadding: clampNum(
      style.backgroundPadding,
      TEXT_LIMITS.backgroundPadding,
      TEXT_DEFAULTS.backgroundPadding,
    ),
    backgroundRadius: clampNum(
      style.backgroundRadius,
      TEXT_LIMITS.backgroundRadius,
      TEXT_DEFAULTS.backgroundRadius,
    ),
    strokeColor: strokeWidth > 0 ? nonEmpty(style.strokeColor) : null,
    strokeWidth,
    shadow: style.shadow === true,
    shadowColor: nonEmpty(style.shadowColor) ?? TEXT_DEFAULTS.shadowColor,
    shadowBlur: clampNum(
      style.shadowBlur,
      TEXT_LIMITS.shadowBlur,
      defaultShadowBlur(fontSize),
    ),
    shadowOffsetX: clampNum(style.shadowOffsetX, TEXT_LIMITS.shadowOffset, 0),
    shadowOffsetY: clampNum(
      style.shadowOffsetY,
      TEXT_LIMITS.shadowOffset,
      defaultShadowOffsetY(fontSize),
    ),
  }
}

/** CSS font shorthand for a resolved style (italic, weight, size, family). */
export function fontShorthand(s: ResolvedTextStyle, size = s.fontSize): string {
  return `${s.italic ? 'italic ' : ''}${String(s.fontWeight)} ${String(size)}px ${s.fontFamily}`
}

/**
 * The style fields of a text style (everything except `content`), each key
 * present — absent values as `undefined` — so applying it as a patch also
 * clears formatting the target had and the style doesn't.
 */
export const TEXT_STYLE_KEYS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'color',
  'background',
  'align',
  'strokeColor',
  'strokeWidth',
  'shadow',
  'italic',
  'underline',
  'letterSpacing',
  'lineHeight',
  'boxWidth',
  'backgroundOpacity',
  'backgroundPadding',
  'backgroundRadius',
  'shadowColor',
  'shadowBlur',
  'shadowOffsetX',
  'shadowOffsetY',
] as const satisfies readonly (keyof RichTextStyle)[]

export type TextStyleKey = (typeof TEXT_STYLE_KEYS)[number]
export type TextStyleFields = Pick<RichTextStyle, TextStyleKey>
