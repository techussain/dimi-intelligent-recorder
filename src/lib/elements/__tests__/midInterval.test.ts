import { describe, expect, it } from 'vitest'
import { drawElement, getTemplate } from '..'
import { createMockContext } from './mockContext'

function textsAt(
  id: string,
  params: Record<string, string | number>,
  t: number,
  d: number,
) {
  const m = createMockContext()
  const tpl = getTemplate(id)
  if (!tpl) throw new Error(`missing ${id}`)
  expect(drawElement(m.ctx, id, params, t, d, tpl.size)).toBe(true)
  // Text drawn while the effective alpha is zero would be invisible.
  return m.calls.filter(([n]) => n === 'fillText').map(([, s]) => String(s))
}

describe('countdown renders every digit (regression)', () => {
  it.each([3, 5])(
    'from=%i: each digit N..1 is drawn mid-interval, then the end text',
    (from) => {
      const d = from + 1
      const stepLen = d / (from + 1)
      for (let i = 0; i < from; i++) {
        const t = (i + 0.5) * stepLen
        expect(textsAt('countdown', { from }, t, d)).toContain(String(from - i))
      }
      expect(
        textsAt('countdown', { from }, from * stepLen + 0.5 * stepLen, d),
      ).toContain('GO!')
    },
  )

  it('also draws a digit exactly at step boundaries (no blank frame)', () => {
    for (const t of [1, 2]) {
      const texts = textsAt('countdown', { from: 3 }, t, 4)
      expect(texts.length).toBeGreaterThan(0)
    }
  })
})

describe('other templates show their text mid-clip', () => {
  it.each([
    ['subscribe', 'SUBSCRIBED'],
    ['like', '+1'],
    ['bell', '1'],
    ['follow', 'Following'],
    ['lowerThird', 'Alex Morgan'],
    ['lowerThird', 'Product Designer'],
  ])('%s draws "%s"', (id, text) => {
    const tpl = getTemplate(id)
    if (!tpl) throw new Error(`missing ${id}`)
    const d = tpl.defaultDuration
    for (const t of [d * 0.5, d * 0.55, d * 0.7]) {
      expect(textsAt(id, {}, t, d)).toContain(text)
    }
  })
})
