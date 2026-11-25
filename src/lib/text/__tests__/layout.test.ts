import { describe, expect, it } from 'vitest'
import { layoutText, underlineRect, wrapParagraph, type MeasureFn } from '../layout'
import { resolveTextStyle, type RichTextStyle } from '../style'

/** Monospace mock: every char is 10 px at 20 px font, plus letter spacing after each char. */
function mono(charW: number, spacing = 0): MeasureFn {
  return (s) => Array.from(s).length * (charW + spacing)
}

function style(over: Partial<RichTextStyle> = {}): RichTextStyle {
  return {
    content: 'Hello',
    fontFamily: 'Inter',
    fontSize: 20,
    fontWeight: 400,
    color: '#fff',
    align: 'center',
    ...over,
  }
}

describe('wrapParagraph', () => {
  it('keeps a line that fits', () => {
    expect(wrapParagraph('one two', 100, mono(10))).toEqual(['one two'])
  })

  it('breaks on spaces greedily', () => {
    // "aaa bbb ccc" at 10 px/char, max 75 → "aaa bbb" is 70.
    expect(wrapParagraph('aaa bbb ccc', 75, mono(10))).toEqual(['aaa bbb', 'ccc'])
    expect(wrapParagraph('aaa bbb ccc', 35, mono(10))).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('breaks words longer than the box between characters', () => {
    expect(wrapParagraph('abcdefghij', 40, mono(10))).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapParagraph('hi abcdefghij yo', 40, mono(10))).toEqual([
      'hi',
      'abcd',
      'efgh',
      'ij',
      'yo',
    ])
  })

  it('puts at least one character on a line even when it is wider than the box', () => {
    expect(wrapParagraph('abc', 5, mono(10))).toEqual(['a', 'b', 'c'])
  })

  it('ignores the trailing letter spacing when fitting', () => {
    // 4 chars × (10 + 2) = 48 advance, visual 46.
    expect(wrapParagraph('abcd', 46, mono(10, 2), 2)).toEqual(['abcd'])
    expect(wrapParagraph('abcd', 45, mono(10, 2), 2)).toEqual(['abc', 'd'])
  })
})

describe('layoutText', () => {
  it('splits on explicit newlines without a box', () => {
    const l = layoutText(resolveTextStyle(style({ content: 'ab\nabcd' })), mono(10))
    expect(l.lines.map((x) => x.text)).toEqual(['ab', 'abcd'])
    expect(l.contentWidth).toBe(40)
    expect(l.contentHeight).toBeCloseTo(2 * 20 * 1.2)
    expect(l.width).toBe(40)
  })

  it('wraps to boxWidth and keeps explicit newlines', () => {
    const l = layoutText(
      resolveTextStyle(style({ content: 'aaa bbb ccc\nd', boxWidth: 75 })),
      mono(10),
    )
    expect(l.lines.map((x) => x.text)).toEqual(['aaa bbb', 'ccc', 'd'])
    // The text area is the box, not the widest line.
    expect(l.contentWidth).toBe(75)
  })

  it('keeps empty lines', () => {
    const l = layoutText(resolveTextStyle(style({ content: 'a\n\nb' })), mono(10))
    expect(l.lines).toHaveLength(3)
    expect(l.lines[1]?.text).toBe('')
  })

  it('aligns lines inside the text area', () => {
    const base = { content: 'aa\naaaa', boxWidth: 100 }
    const left = layoutText(
      resolveTextStyle(style({ ...base, align: 'left' })),
      mono(10),
    )
    expect(left.lines.map((x) => x.x)).toEqual([-50, -50])
    const right = layoutText(
      resolveTextStyle(style({ ...base, align: 'right' })),
      mono(10),
    )
    expect(right.lines.map((x) => x.x + x.width)).toEqual([50, 50])
    const center = layoutText(resolveTextStyle(style(base)), mono(10))
    expect(center.lines.map((x) => x.x)).toEqual([-10, -20])
  })

  it('letter spacing widens the box (minus the trailing spacing)', () => {
    const plain = layoutText(resolveTextStyle(style({ content: 'abcd' })), mono(10))
    // 0.1 em at 20 px = 2 px per char.
    const spaced = layoutText(
      resolveTextStyle(style({ content: 'abcd', letterSpacing: 0.1 })),
      mono(10, 2),
    )
    expect(plain.width).toBe(40)
    expect(spaced.letterSpacingPx).toBeCloseTo(2)
    expect(spaced.width).toBeCloseTo(46)
  })

  it('line height scales the box height and line positions', () => {
    const l = layoutText(
      resolveTextStyle(style({ content: 'a\nb\nc', lineHeight: 2 })),
      mono(10),
    )
    expect(l.lineHeight).toBe(40)
    expect(l.height).toBe(120)
    expect(l.lines.map((x) => x.y)).toEqual([-40, 0, 40])
  })

  it('adds background padding (em, vertical half) only with a background', () => {
    const none = layoutText(resolveTextStyle(style({ backgroundPadding: 1 })), mono(10))
    expect(none.padX).toBe(0)
    const bg = layoutText(
      resolveTextStyle(style({ background: '#000', backgroundPadding: 0.5 })),
      mono(10),
    )
    expect(bg.padX).toBe(10)
    expect(bg.padY).toBe(5)
    expect(bg.width).toBe(50 + 20)
    expect(bg.height).toBeCloseTo(24 + 10)
  })

  it('defaults the background padding to the legacy look (0.2 em × 0.1 em)', () => {
    const l = layoutText(resolveTextStyle(style({ background: '#000' })), mono(10))
    expect(l.width).toBeCloseTo(50 + 20 * 0.4)
    expect(l.height).toBeCloseTo(24 + 20 * 0.2)
  })
})

describe('underlineRect', () => {
  it('spans the visual line width under the baseline, thickness ∝ size', () => {
    const l = layoutText(
      resolveTextStyle(style({ content: 'abcd', letterSpacing: 0.1, align: 'left' })),
      mono(10, 2),
    )
    const line = l.lines[0]
    if (!line) throw new Error('no line')
    const u = underlineRect(line, 20, 7)
    expect(u).not.toBeNull()
    expect(u?.x).toBe(line.x)
    expect(u?.w).toBeCloseTo(46)
    expect(u?.h).toBeCloseTo(1.2)
    // Centre at middle + baseline + 0.1 em.
    expect((u?.y ?? 0) + (u?.h ?? 0) / 2).toBeCloseTo(line.y + 7 + 2)
    const big = underlineRect(line, 100, 35)
    expect(big?.h).toBeCloseTo(6)
  })

  it('skips blank lines', () => {
    expect(underlineRect({ text: '  ', width: 20, x: 0, y: 0 }, 20, 7)).toBeNull()
    expect(underlineRect({ text: '', width: 0, x: 0, y: 0 }, 20, 7)).toBeNull()
  })
})
