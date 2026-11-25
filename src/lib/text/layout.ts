import type { ResolvedTextStyle } from './style'

/**
 * Advance width of `s` in project px with the style's font AND letter
 * spacing applied, the way Canvas measures it: the spacing is added after
 * every character, including the last.
 */
export type MeasureFn = (s: string) => number

export interface LaidOutLine {
  text: string
  /** Visual width (without the trailing letter spacing), project px. */
  width: number
  /** Left edge of the line, relative to the block centre. */
  x: number
  /** Vertical centre of the line box (textBaseline 'middle'), relative to the block centre. */
  y: number
}

export interface TextLayout {
  lines: LaidOutLine[]
  /** Width of the text area: the wrap width when wrapping, else the widest line. */
  contentWidth: number
  /** lines × line height. */
  contentHeight: number
  /** Line box height (fontSize × lineHeight). */
  lineHeight: number
  /** Letter spacing in px. */
  letterSpacingPx: number
  /** Background padding (0 without a background). */
  padX: number
  padY: number
  /** Full box (text area + padding), centred on the anchor. */
  width: number
  height: number
}

export interface UnderlineRect {
  x: number
  y: number
  w: number
  h: number
}

/** Visual width: Canvas adds letter spacing after the last glyph too. */
function visualWidth(s: string, measure: MeasureFn, spacing: number): number {
  if (s === '') return 0
  return Math.max(0, measure(s) - spacing)
}

/**
 * Break one paragraph (no newlines) into lines no wider than `maxWidth`:
 * greedy on spaces; a word wider than the box is broken between characters.
 * Spaces at a wrap point are dropped.
 */
export function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  measure: MeasureFn,
  spacing = 0,
): string[] {
  const width = (s: string) => visualWidth(s, measure, spacing)
  if (paragraph === '' || width(paragraph) <= maxWidth) return [paragraph]
  const words = paragraph.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (width(candidate) <= maxWidth) {
      line = candidate
      continue
    }
    if (line !== '') lines.push(line)
    line = ''
    if (width(word) <= maxWidth) {
      line = word
      continue
    }
    // Break the long word by characters (code points); ≥ 1 char per line.
    let chunk = ''
    for (const ch of Array.from(word)) {
      const next = chunk + ch
      if (chunk !== '' && width(next) > maxWidth) {
        lines.push(chunk)
        chunk = ch
      } else {
        chunk = next
      }
    }
    line = chunk
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}

/**
 * Lay a text style out: lines (explicit newlines, then word wrap to
 * `boxWidth`), their alignment inside the text area, and the full box
 * (text area + background padding) centred on (0, 0). Pure: all measuring
 * goes through `measure`.
 */
export function layoutText(style: ResolvedTextStyle, measure: MeasureFn): TextLayout {
  const size = style.fontSize
  const spacing = style.letterSpacing * size
  const lineHeight = size * style.lineHeight
  const paragraphs = style.content.split(/\r?\n/)
  const texts =
    style.boxWidth === null
      ? paragraphs
      : paragraphs.flatMap((p) =>
          wrapParagraph(p, style.boxWidth ?? 0, measure, spacing),
        )
  const widths = texts.map((t) => visualWidth(t, measure, spacing))
  const widest = Math.max(1, ...widths)
  const contentWidth = style.boxWidth ?? widest
  const contentHeight = lineHeight * texts.length
  const padX = style.background ? style.backgroundPadding * size : 0
  const padY = padX / 2
  const left = -contentWidth / 2
  const top = -contentHeight / 2
  const lines = texts.map((text, i) => {
    const w = widths[i] ?? 0
    const x =
      style.align === 'left'
        ? left
        : style.align === 'right'
          ? left + contentWidth - w
          : left + (contentWidth - w) / 2
    return { text, width: w, x, y: top + lineHeight * (i + 0.5) }
  })
  return {
    lines,
    contentWidth,
    contentHeight,
    lineHeight,
    letterSpacingPx: spacing,
    padX,
    padY,
    width: contentWidth + padX * 2,
    height: contentHeight + padY * 2,
  }
}

/**
 * Underline of one laid-out line. `baseline` is the distance from the line's
 * middle to its alphabetic baseline (px, positive = below); the line sits a
 * little under the baseline with a thickness proportional to the size.
 */
export function underlineRect(
  line: LaidOutLine,
  fontSize: number,
  baseline: number,
): UnderlineRect | null {
  if (line.width <= 0 || line.text.trim() === '') return null
  const h = Math.max(1, fontSize * 0.06)
  return {
    x: line.x,
    y: line.y + baseline + fontSize * 0.1 - h / 2,
    w: line.width,
    h,
  }
}

/** Default middle→alphabetic-baseline distance when the font can't say. */
export function defaultBaseline(fontSize: number): number {
  return fontSize * 0.35
}
