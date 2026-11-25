import { describe, it, expect } from 'vitest'
import {
  keyAlpha,
  keyImageData,
  parseHexColor,
  rgbToCbCr,
  spillChannel,
  suggestKeyColorFromPixels,
  suppressSpill,
  toHexColor,
} from '../chromaKey'

const params = { color: '#00ff00', similarity: 0.4, smoothness: 0.08, spill: 1 }

/** w×h RGBA buffer filled with one colour. */
function fill(w: number, h: number, rgb: readonly [number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) d.set([rgb[0], rgb[1], rgb[2], 255], i * 4)
  return d
}
function setPx(d: Uint8ClampedArray, w: number, x: number, y: number, rgb: number[]) {
  d.set([...rgb, 255], (y * w + x) * 4)
}

describe('colour helpers', () => {
  it('parses and formats hex colours', () => {
    expect(parseHexColor('#00ff00')).toEqual([0, 255, 0])
    expect(parseHexColor('#0af')).toEqual([0, 170, 255])
    expect(parseHexColor('nope')).toEqual([0, 255, 0])
    expect(toHexColor(0, 177.6, 64)).toBe('#00b240')
  })
  it('puts greys at the CbCr centre and greens far from it', () => {
    const [cb, cr] = rgbToCbCr(0.5, 0.5, 0.5)
    expect(cb).toBeCloseTo(0.5)
    expect(cr).toBeCloseTo(0.5)
    const [gcb, gcr] = rgbToCbCr(0, 1, 0)
    expect(Math.hypot(gcb - 0.5, gcr - 0.5)).toBeGreaterThan(0.5)
  })
  it('chooses the spill channel from the key colour', () => {
    expect(spillChannel([0, 255, 0])).toBe(2)
    expect(spillChannel([0, 70, 230])).toBe(3)
    expect(spillChannel([200, 10, 10])).toBe(1)
    expect(spillChannel([128, 128, 130])).toBe(0)
  })
})

describe('key maths', () => {
  it('alpha ramps from similarity to similarity + smoothness', () => {
    expect(keyAlpha(0.3, 0.4, 0.1)).toBe(0)
    expect(keyAlpha(0.45, 0.4, 0.1)).toBeCloseTo(0.5)
    expect(keyAlpha(0.6, 0.4, 0.1)).toBe(1)
    // zero smoothness is a hard edge, not NaN
    expect(keyAlpha(0.41, 0.4, 0)).toBe(1)
  })
  it('suppresses green spill toward max(r, b)', () => {
    const [r, g, b] = suppressSpill(0.4, 0.9, 0.3, 2, 1)
    expect([r, g, b]).toEqual([0.4, 0.4, 0.3])
    expect(suppressSpill(0.4, 0.9, 0.3, 2, 0.5)[1]).toBeCloseTo(0.65)
    expect(suppressSpill(0.4, 0.9, 0.3, 2, 0)).toEqual([0.4, 0.9, 0.3])
  })
  it('suppresses blue spill for blue keys', () => {
    const [r, g, b] = suppressSpill(0.2, 0.3, 0.9, 3, 1)
    expect(r).toBe(0.2)
    expect(g).toBe(0.3)
    expect(b).toBeCloseTo(0.3)
  })
})

describe('keyImageData (CPU path)', () => {
  it('makes the screen transparent and keeps the subject', () => {
    const w = 7
    const h = 7
    const d = fill(w, h, [20, 220, 30]) // a typical, not-pure green screen
    for (let y = 2; y < 5; y++)
      for (let x = 2; x < 5; x++) setPx(d, w, x, y, [220, 170, 140])
    keyImageData(d, w, h, params)
    expect(d[3]).toBe(0) // corner fully keyed
    const centre = (3 * w + 3) * 4
    expect(d[centre + 3]).toBe(255)
    // Skin has no green excess, so spill removal leaves it alone.
    expect([d[centre], d[centre + 1], d[centre + 2]]).toEqual([220, 170, 140])
  })
  it('smooths the distance: a lone subject-coloured pixel in the screen is keyed', () => {
    const w = 3
    const h = 3
    const d = fill(w, h, [20, 220, 30])
    setPx(d, w, 1, 1, [220, 170, 140])
    keyImageData(d, w, h, params)
    expect(d[(1 * w + 1) * 4 + 3]).toBe(0)
  })
  it('keeps a neutral subject opaque and removes green spill', () => {
    const w = 3
    const h = 3
    const d = fill(w, h, [160, 165, 150]) // slightly green-tinted grey (spill)
    keyImageData(d, w, h, params)
    expect(d[3]).toBe(255)
    expect(d[1]).toBe(160) // g pulled down to max(r, b)
  })
  it('keeps the source alpha', () => {
    const d = new Uint8ClampedArray([200, 50, 50, 100])
    keyImageData(d, 1, 1, params)
    expect(d[3]).toBe(100)
  })
})

describe('suggestKeyColorFromPixels', () => {
  it('finds the green screen around a centred subject', () => {
    const w = 20
    const h = 20
    const d = fill(w, h, [30, 200, 60])
    for (let y = 4; y < 16; y++)
      for (let x = 4; x < 16; x++) setPx(d, w, x, y, [200, 150, 120])
    expect(suggestKeyColorFromPixels(d, w, h)).toBe('#1ec83c')
  })
  it('finds a blue screen even when the subject touches the bottom edge', () => {
    const w = 20
    const h = 20
    const d = fill(w, h, [20, 60, 220])
    for (let y = 8; y < 20; y++)
      for (let x = 6; x < 14; x++) setPx(d, w, x, y, [180, 40, 40])
    expect(suggestKeyColorFromPixels(d, w, h)).toBe('#143cdc')
  })
  it('ignores unsaturated borders and falls back to pure green', () => {
    expect(suggestKeyColorFromPixels(fill(8, 8, [128, 128, 128]), 8, 8)).toBe('#00ff00')
    expect(suggestKeyColorFromPixels(fill(8, 8, [5, 10, 5]), 8, 8)).toBe('#00ff00')
  })
})
