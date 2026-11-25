import { describe, expect, it } from 'vitest'
import { drawTextSource, measureTextLayout } from '../textRender'
import type { RichTextStyle } from '../../text/style'

type Call = [string, ...unknown[]]

/** Minimal 2D context: monospace metrics (0.5 em per char) + native letterSpacing. */
function mockCtx() {
  const calls: Call[] = []
  const state = { font: '10px x', letterSpacing: '0px' }
  const stack: (typeof state)[] = []
  const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 10)
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  const ctx = {
    get font() {
      return state.font
    },
    set font(v: string) {
      state.font = v
      calls.push(['font', v])
    },
    get letterSpacing() {
      return state.letterSpacing
    },
    set letterSpacing(v: string) {
      state.letterSpacing = v
    },
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: '',
    miterLimit: 10,
    textAlign: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    measureText: (s: string) => ({
      width: Array.from(s).length * (size() * 0.5 + parseFloat(state.letterSpacing)),
      alphabeticBaseline: -size() * 0.3,
    }),
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    translate: rec('translate'),
    rotate: rec('rotate'),
    scale: rec('scale'),
    beginPath: rec('beginPath'),
    rect: rec('rect'),
    roundRect: rec('roundRect'),
    fill: rec('fill'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx }
}

const base: RichTextStyle = {
  content: 'abcd',
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 20,
  fontWeight: 700,
  color: '#fff',
  align: 'center',
}

describe('drawTextSource', () => {
  it('returns the legacy box for a plain style (centred on frame + offset)', () => {
    const { ctx } = mockCtx()
    const r = drawTextSource(ctx, base, 1000, 500, { x: 10, y: -20 })
    // 4 chars × 10 px; one line of 1.2 × 20.
    expect(r).toEqual({ x: 500 + 10 - 20, y: 250 - 20 - 12, w: 40, h: 24 })
  })

  it('uses the italic font string and the bundled family', () => {
    const { ctx, calls } = mockCtx()
    drawTextSource(ctx, { ...base, italic: true }, 100, 100)
    expect(calls.find((c) => c[0] === 'font')?.[1]).toBe(
      'italic 700 20px "Inter Variable", Inter, system-ui, sans-serif',
    )
  })

  it('letter spacing and line height grow the box; scale scales it', () => {
    const { ctx } = mockCtx()
    const r = drawTextSource(
      ctx,
      { ...base, content: 'abcd\nab', letterSpacing: 0.1, lineHeight: 2 },
      0,
      0,
      { scaleX: 2, scaleY: 0.5 },
    )
    // widest: 4 × (10 + 2) − 2 = 46; height 2 lines × 40.
    expect(r.w).toBeCloseTo(92)
    expect(r.h).toBeCloseTo(40)
    expect(r.x).toBeCloseTo(-46)
    expect(r.y).toBeCloseTo(-20)
  })

  it('draws lines left-aligned at computed x (alignment done by layout)', () => {
    const { ctx, calls } = mockCtx()
    drawTextSource(ctx, { ...base, content: 'ab\nabcd', align: 'right' }, 0, 0)
    const texts = calls.filter((c) => c[0] === 'fillText')
    expect(texts.map((c) => [c[1], c[2]])).toEqual([
      ['ab', 0],
      ['abcd', -20],
    ])
  })

  it('wraps to boxWidth', () => {
    const { ctx, calls } = mockCtx()
    const r = drawTextSource(
      ctx,
      { ...base, content: 'aaa bbb ccc', boxWidth: 75 },
      0,
      0,
    )
    expect(calls.filter((c) => c[0] === 'fillText').map((c) => c[1])).toEqual([
      'aaa bbb',
      'ccc',
    ])
    expect(r.w).toBe(75)
    expect(r.h).toBeCloseTo(48)
  })

  it('draws a rounded, translucent background enclosed by the returned box', () => {
    const { ctx, calls, raw } = mockCtx()
    let alphaAtFill = -1
    raw.fill = () => {
      alphaAtFill = raw.globalAlpha
      calls.push(['fill'])
    }
    const r = drawTextSource(
      ctx,
      {
        ...base,
        background: '#000',
        backgroundOpacity: 0.5,
        backgroundPadding: 0.5,
        backgroundRadius: 100,
      },
      0,
      0,
    )
    // pad 10 / 5 → 60 × 34.
    expect(r).toEqual({ x: -30, y: -17, w: 60, h: 34 })
    const rr = calls.find((c) => c[0] === 'roundRect')
    // Radius clamped to half the short side.
    expect(rr?.slice(1)).toEqual([-30, -17, 60, 34, 17])
    expect(alphaAtFill).toBe(0.5)
    expect(raw.globalAlpha).toBe(1)
  })

  it('uses a plain rect without a radius', () => {
    const { ctx, calls } = mockCtx()
    drawTextSource(ctx, { ...base, background: '#000' }, 0, 0)
    expect(calls.some((c) => c[0] === 'rect')).toBe(true)
    expect(calls.some((c) => c[0] === 'roundRect')).toBe(false)
  })

  it('draws an underline per non-empty line under the baseline', () => {
    const { ctx, calls } = mockCtx()
    drawTextSource(ctx, { ...base, content: 'ab\n\nabcd', underline: true }, 0, 0)
    const rects = calls.filter((c) => c[0] === 'fillRect')
    expect(rects).toHaveLength(2)
    const [, x, y, w, h] = rects[1] as [string, number, number, number, number]
    expect(x).toBe(-20)
    expect(w).toBe(40)
    expect(h).toBeCloseTo(1.2)
    // Line 3 centre is +24; baseline 6 below; underline 2 below that.
    expect(y + h / 2).toBeCloseTo(24 + 6 + 2)
  })

  it('applies the configured shadow scaled by pxScale and clip scale', () => {
    const { ctx, raw } = mockCtx()
    let seen = { blur: 0, x: 0, y: 0, color: '' }
    raw.fillText = () => {
      seen = {
        blur: raw.shadowBlur,
        x: raw.shadowOffsetX,
        y: raw.shadowOffsetY,
        color: raw.shadowColor,
      }
    }
    drawTextSource(
      ctx,
      {
        ...base,
        shadow: true,
        shadowColor: '#ff0000',
        shadowBlur: 4,
        shadowOffsetX: 3,
        shadowOffsetY: -2,
      },
      0,
      0,
      { scaleX: 2, scaleY: 2 },
      0.5,
    )
    expect(seen).toEqual({ blur: 4, x: 3, y: -2, color: '#ff0000' })
  })

  it('strokes before filling when a stroke is set', () => {
    const { ctx, calls } = mockCtx()
    drawTextSource(ctx, { ...base, strokeColor: '#000', strokeWidth: 3 }, 0, 0)
    const order = calls.filter((c) => c[0] === 'strokeText' || c[0] === 'fillText')
    expect(order.map((c) => c[0])).toEqual(['strokeText', 'fillText'])
  })

  it('measureTextLayout lays out without drawing and restores the state', () => {
    const { ctx, calls, raw } = mockCtx()
    const l = measureTextLayout(ctx, { ...base, letterSpacing: 0.5 })
    expect(l.width).toBeCloseTo(4 * 20 - 10)
    expect(calls.some((c) => c[0] === 'fillText')).toBe(false)
    expect(raw.letterSpacing).toBe('0px')
  })
})
