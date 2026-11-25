import { describe, expect, it, vi } from 'vitest'
import { ELEMENT_TEMPLATES, drawElement, getTemplate, resolveParams } from '..'
import { envelope, mix, spring } from '../anim'
import type { ElementParams, ElementTemplate } from '../types'
import { createMockContext, nonFinite } from './mockContext'

const BOXES = [
  { w: 1, h: 1 },
  { w: 160, h: 90 },
  { w: 640, h: 200 },
  { w: 1920, h: 1080 },
  { w: 200, h: 800 },
]

const CASES = ELEMENT_TEMPLATES.map((t) => [t.id, t] as [string, ElementTemplate])

function timesFor(d: number): number[] {
  return [0, 0.3, 1, d / 2, d - 0.2, d, d + 1]
}

describe('element registry', () => {
  it('has the 8 templates with unique ids', () => {
    const ids = ELEMENT_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual([
      'subscribe',
      'like',
      'bell',
      'follow',
      'lowerThird',
      'arrow',
      'highlightCircle',
      'countdown',
    ])
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(getTemplate(id)?.id).toBe(id)
    expect(getTemplate('nope')).toBeUndefined()
  })

  it.each(CASES)('%s has valid metadata and defaults', (_id, tpl) => {
    expect(tpl.name.length).toBeGreaterThan(0)
    expect(tpl.defaultDuration).toBeGreaterThan(1)
    expect(tpl.size.w).toBeGreaterThan(0)
    expect(tpl.size.h).toBeGreaterThan(0)
    const keys = tpl.params.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(Object.keys(tpl.defaults).sort()).toEqual([...keys].sort())
    for (const def of tpl.params) {
      const v = tpl.defaults[def.key]
      if (def.kind === 'color') expect(v).toMatch(/^#[0-9a-fA-F]{6}$/)
      if (def.kind === 'text') {
        expect(typeof v).toBe('string')
        if (def.options) expect(def.options.map((o) => o.value)).toContain(v)
        if (def.maxLength !== undefined)
          expect(String(v).length).toBeLessThanOrEqual(def.maxLength)
      }
      if (def.kind === 'number') {
        expect(typeof v).toBe('number')
        expect(v).toBeGreaterThanOrEqual(def.min)
        expect(v).toBeLessThanOrEqual(def.max)
      }
    }
    // Defaults survive resolution unchanged.
    expect(resolveParams(tpl, {})).toEqual(tpl.defaults)
  })
})

describe('template drawing', () => {
  it.each(CASES)(
    '%s draws at every phase and box size without throwing or NaN',
    (_id, tpl) => {
      for (const box of BOXES) {
        for (const t of timesFor(tpl.defaultDuration)) {
          const m = createMockContext()
          expect(() => {
            tpl.draw(m.ctx, tpl.defaults, t, tpl.defaultDuration, box)
          }).not.toThrow()
          expect(nonFinite(m.calls)).toEqual([])
          expect(m.depth()).toBe(0)
        }
      }
    },
  )

  it.each(CASES)('%s actually paints something mid-clip', (_id, tpl) => {
    const m = createMockContext()
    tpl.draw(
      m.ctx,
      tpl.defaults,
      tpl.defaultDuration / 2,
      tpl.defaultDuration,
      tpl.size,
    )
    const painted = m.calls.filter(([n]) =>
      ['fill', 'stroke', 'fillText', 'fillRect'].includes(n),
    )
    expect(painted.length).toBeGreaterThan(0)
  })

  it.each(CASES)('%s is deterministic in t', (_id, tpl) => {
    for (const t of [0.4, 1.37, tpl.defaultDuration - 0.1]) {
      const a = createMockContext()
      const b = createMockContext()
      tpl.draw(a.ctx, tpl.defaults, t, tpl.defaultDuration, tpl.size)
      tpl.draw(b.ctx, tpl.defaults, t, tpl.defaultDuration, tpl.size)
      // Gradients carry closures, so compare the serialized call log.
      expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls))
    }
  })

  it.each(CASES)(
    '%s handles short/long clips, empty text and extreme params',
    (_id, tpl) => {
      const extreme: ElementParams = {}
      const long: ElementParams = {}
      for (const def of tpl.params) {
        if (def.kind === 'text') {
          extreme[def.key] = ''
          if (!def.options) long[def.key] = 'W'.repeat(def.maxLength ?? 40)
        }
        if (def.kind === 'number') {
          extreme[def.key] = def.max
          long[def.key] = def.min
        }
        if (def.kind === 'color') extreme[def.key] = '#000000'
      }
      for (const params of [extreme, long]) {
        const p = resolveParams(tpl, params)
        for (const d of [0.3, 1, 30]) {
          for (const t of [0, d / 3, d / 2, d - 0.01]) {
            const m = createMockContext()
            tpl.draw(m.ctx, p, t, d, tpl.size)
            expect(nonFinite(m.calls)).toEqual([])
          }
        }
      }
    },
  )

  it('only multiplies globalAlpha, never raises it', () => {
    for (const tpl of ELEMENT_TEMPLATES) {
      for (const t of timesFor(tpl.defaultDuration)) {
        const m = createMockContext()
        m.ctx.globalAlpha = 0.5
        tpl.draw(m.ctx, tpl.defaults, t, tpl.defaultDuration, tpl.size)
        const sets = m.calls.filter(([n]) => n === 'set:globalAlpha').slice(1)
        for (const [, v] of sets) expect(Number(v)).toBeLessThanOrEqual(0.5 + 1e-9)
      }
    }
  })
})

describe('drawElement', () => {
  it('ignores unknown templates without touching the context', () => {
    const m = createMockContext()
    expect(drawElement(m.ctx, 'does-not-exist', {}, 1, 3, { w: 100, h: 100 })).toBe(
      false,
    )
    expect(m.calls).toEqual([])
  })

  it('draws nothing outside [0, duration] or for an empty box', () => {
    const m = createMockContext()
    const box = { w: 100, h: 100 }
    expect(drawElement(m.ctx, 'like', {}, -0.1, 3, box)).toBe(false)
    expect(drawElement(m.ctx, 'like', {}, 3.5, 3, box)).toBe(false)
    expect(drawElement(m.ctx, 'like', {}, Number.NaN, 3, box)).toBe(false)
    expect(drawElement(m.ctx, 'like', {}, 1, 3, { w: 0, h: 100 })).toBe(false)
    expect(m.calls).toEqual([])
  })

  it('draws with balanced save/restore and merges defaults', () => {
    const m = createMockContext()
    expect(
      drawElement(m.ctx, 'lowerThird', { name: 'Sam' }, 2, 5, { w: 960, h: 220 }),
    ).toBe(true)
    expect(m.depth()).toBe(0)
    const texts = m.calls.filter(([n]) => n === 'fillText').map(([, s]) => s)
    expect(texts).toContain('Sam')
    expect(texts).toContain('Product Designer')
  })

  it('falls back to the default duration when duration is invalid', () => {
    const m = createMockContext()
    expect(drawElement(m.ctx, 'bell', null, 1, Number.NaN, { w: 100, h: 100 })).toBe(
      true,
    )
  })

  it('catches template errors, restores the context and logs once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const m = createMockContext()
    const broken = new Proxy(m.ctx, {
      get(target, prop, recv) {
        if (prop === 'fillText') {
          return () => {
            throw new Error('boom')
          }
        }
        return Reflect.get(target, prop, recv) as unknown
      },
    })
    expect(drawElement(broken, 'countdown', {}, 1, 4, { w: 400, h: 400 })).toBe(false)
    expect(drawElement(broken, 'countdown', {}, 1.5, 4, { w: 400, h: 400 })).toBe(false)
    expect(m.depth()).toBe(0)
    expect(spy).toHaveBeenCalledTimes(1)
    // The context's own save/restore are back in place.
    expect(Object.prototype.hasOwnProperty.call(m.ctx, 'save')).toBe(false)
    m.ctx.save()
    expect(m.depth()).toBe(1)
  })
})

describe('params + anim helpers', () => {
  it('resolveParams coerces, validates and clamps', () => {
    const tpl = getTemplate('countdown')
    if (!tpl) throw new Error('missing')
    expect(
      resolveParams(tpl, { from: 99, color: 'red', endText: 5, extra: 'x' }),
    ).toEqual({
      from: 10,
      endText: '5',
      color: '#7C3AED',
      textColor: '#FFFFFF',
    })
    expect(resolveParams(tpl, { from: '4' }).from).toBe(4)
    const arrow = getTemplate('arrow')
    if (!arrow) throw new Error('missing')
    expect(resolveParams(arrow, { direction: 'sideways' }).direction).toBe('right')
    expect(resolveParams(arrow, { direction: 'up' }).direction).toBe('up')
  })

  it('envelope shortens intro/outro for short clips', () => {
    const e = envelope(0.1, 0.5)
    expect(e.introLen + e.outroLen).toBeCloseTo(0.4)
    expect(envelope(10, 10).outro).toBe(1)
    expect(envelope(0, 10).intro).toBe(0)
  })

  it('spring overshoots and settles at 1', () => {
    expect(spring(0)).toBe(0)
    expect(spring(5)).toBeCloseTo(1, 3)
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => spring(i / 100)))
    expect(peak).toBeGreaterThan(1)
  })

  it('mix returns hex for opaque colors', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#ff0000', '#0000ff', 0, 0.5)).toBe('rgba(255,0,0,0.500)')
  })
})
