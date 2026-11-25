import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXT_FONT,
  FONT_OPTIONS,
  fontOptionFor,
  nearestWeight,
  normalizeFontFamily,
} from '../fonts'
import { formatColor, parseColor } from '../color'

describe('fonts', () => {
  it('bundles the planned families', () => {
    expect(FONT_OPTIONS.map((o) => o.label)).toEqual([
      'Inter',
      'Montserrat',
      'Poppins',
      'Roboto Slab',
      'Playfair Display',
      'Bebas Neue',
      'JetBrains Mono',
    ])
    expect(FONT_OPTIONS[0]?.family).toBe(DEFAULT_TEXT_FONT)
  })

  it('finds the option by the first family, quoted or not, any case', () => {
    expect(fontOptionFor('Inter, system-ui, sans-serif')?.id).toBe('inter')
    expect(fontOptionFor('"Inter Variable", sans-serif')?.id).toBe('inter')
    expect(fontOptionFor("'bebas neue'")?.id).toBe('bebas-neue')
    expect(fontOptionFor('Arial, Inter')).toBeUndefined()
  })

  it('normalizes legacy families to the registered stack', () => {
    expect(normalizeFontFamily('Inter, system-ui, sans-serif')).toBe(DEFAULT_TEXT_FONT)
    expect(normalizeFontFamily('Montserrat')).toBe(FONT_OPTIONS[1]?.family)
    expect(normalizeFontFamily('Georgia, serif')).toBe('Georgia, serif')
    expect(normalizeFontFamily('')).toBe(DEFAULT_TEXT_FONT)
  })

  it('snaps to the nearest supported weight', () => {
    const poppins = fontOptionFor('Poppins')
    const bebas = fontOptionFor('Bebas Neue')
    if (!poppins || !bebas) throw new Error('missing font')
    expect(nearestWeight(poppins, 500)).toBe(600)
    expect(nearestWeight(poppins, 900)).toBe(800)
    expect(nearestWeight(poppins, 100)).toBe(400)
    expect(nearestWeight(bebas, 700)).toBe(400)
  })
})

describe('colour helpers', () => {
  const fb = { hex: '#000000', alpha: 1 }
  it('parses hex and rgb(a)', () => {
    expect(parseColor('#fff', fb)).toEqual({ hex: '#ffffff', alpha: 1 })
    expect(parseColor('#11223380', fb).hex).toBe('#112233')
    expect(parseColor('#11223380', fb).alpha).toBeCloseTo(128 / 255)
    expect(parseColor('rgba(0,0,0,0.55)', fb)).toEqual({ hex: '#000000', alpha: 0.55 })
    expect(parseColor('rgb(255 128 0 / 50%)', fb)).toEqual({
      hex: '#ff8000',
      alpha: 0.5,
    })
    expect(parseColor('tomato', fb)).toBe(fb)
  })

  it('formats opaque as hex, translucent as rgba', () => {
    expect(formatColor('#ff8000', 1)).toBe('#ff8000')
    expect(formatColor('#ff8000', 0.5)).toBe('rgba(255,128,0,0.5)')
    expect(formatColor('#000000', -1)).toBe('rgba(0,0,0,0)')
  })
})
