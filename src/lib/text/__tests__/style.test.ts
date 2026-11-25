import { describe, expect, it } from 'vitest'
import {
  fontShorthand,
  resolveTextStyle,
  TEXT_LIMITS,
  type RichTextStyle,
} from '../style'
import { DEFAULT_TEXT_FONT } from '../fonts'

const base: RichTextStyle = {
  content: 'Hi',
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 72,
  fontWeight: 700,
  color: '#ffffff',
  align: 'center',
}

describe('resolveTextStyle', () => {
  it('fills the defaults (legacy look)', () => {
    const r = resolveTextStyle(base)
    expect(r).toMatchObject({
      italic: false,
      underline: false,
      letterSpacing: 0,
      lineHeight: 1.2,
      boxWidth: null,
      background: null,
      backgroundOpacity: 1,
      backgroundPadding: 0.2,
      backgroundRadius: 0,
      strokeColor: null,
      strokeWidth: 0,
      shadow: false,
      shadowColor: 'rgba(0,0,0,0.55)',
      shadowOffsetX: 0,
    })
    expect(r.shadowBlur).toBeCloseTo(72 * 0.06)
    expect(r.shadowOffsetY).toBeCloseTo(72 * 0.03)
  })

  it('maps the legacy Inter default onto the bundled family', () => {
    expect(resolveTextStyle(base).fontFamily).toBe(DEFAULT_TEXT_FONT)
    expect(resolveTextStyle({ ...base, fontFamily: 'Comic Sans MS' }).fontFamily).toBe(
      'Comic Sans MS',
    )
  })

  it('clamps out-of-range values', () => {
    const r = resolveTextStyle({
      ...base,
      fontSize: 99999,
      fontWeight: 1234,
      letterSpacing: 50,
      lineHeight: 0,
      backgroundOpacity: 3,
      backgroundPadding: -1,
      backgroundRadius: -5,
      strokeWidth: 500,
      strokeColor: '#000',
      shadowBlur: -3,
      shadowOffsetX: 9999,
      shadowOffsetY: -9999,
      boxWidth: 3,
    })
    expect(r.fontSize).toBe(TEXT_LIMITS.fontSize.max)
    expect(r.fontWeight).toBe(900)
    expect(r.letterSpacing).toBe(TEXT_LIMITS.letterSpacing.max)
    expect(r.lineHeight).toBe(TEXT_LIMITS.lineHeight.min)
    expect(r.backgroundOpacity).toBe(1)
    expect(r.backgroundPadding).toBe(0)
    expect(r.backgroundRadius).toBe(0)
    expect(r.strokeWidth).toBe(TEXT_LIMITS.strokeWidth.max)
    expect(r.shadowBlur).toBe(0)
    expect(r.shadowOffsetX).toBe(TEXT_LIMITS.shadowOffset.max)
    expect(r.shadowOffsetY).toBe(TEXT_LIMITS.shadowOffset.min)
    expect(r.boxWidth).toBe(TEXT_LIMITS.boxWidth.min)
  })

  it('treats non-finite numbers as unset', () => {
    const r = resolveTextStyle({ ...base, lineHeight: Number.NaN, boxWidth: Infinity })
    expect(r.lineHeight).toBe(1.2)
    expect(r.boxWidth).toBeNull()
  })

  it('drops a stroke without width and blank colours', () => {
    expect(
      resolveTextStyle({ ...base, strokeColor: '#000', strokeWidth: 0 }).strokeColor,
    ).toBe(null)
    expect(resolveTextStyle({ ...base, background: '' }).background).toBeNull()
    expect(resolveTextStyle({ ...base, boxWidth: 0 }).boxWidth).toBeNull()
  })

  it('builds the font shorthand with italic', () => {
    const r = resolveTextStyle({ ...base, italic: true })
    expect(fontShorthand(r)).toBe(`italic 700 72px ${DEFAULT_TEXT_FONT}`)
    expect(fontShorthand(resolveTextStyle(base), 48)).toBe(
      `700 48px ${DEFAULT_TEXT_FONT}`,
    )
  })
})
