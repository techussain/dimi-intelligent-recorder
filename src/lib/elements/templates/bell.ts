import {
  clamp01,
  clearShadow,
  dampedSine,
  designSpace,
  drawRipple,
  envelope,
  fitFont,
  mulAlpha,
  outroPop,
  range,
  setShadow,
  shade,
  spring,
  traceBellBody,
  traceBellClapper,
} from '../anim'
import { color, str } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 340, h: 340 }
const RING_EVERY = 1.8
const FIRST_RING = 0.4

export const bell: ElementTemplate = {
  id: 'bell',
  name: 'Notification bell',
  category: 'social',
  defaultDuration: 3.5,
  size: SIZE,
  params: [
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'color', key: 'iconColor', label: 'Icon color' },
    { kind: 'color', key: 'badgeColor', label: 'Badge color' },
    { kind: 'text', key: 'badgeText', label: 'Badge text', maxLength: 3 },
  ],
  defaults: {
    color: '#7C3AED',
    iconColor: '#FFFFFF',
    badgeColor: '#F43F5E',
    badgeText: '1',
  },
  draw(ctx, params, t, duration, box) {
    const c = color(params, 'color', '#7C3AED')
    const iconColor = color(params, 'iconColor', '#FFFFFF')
    const badgeColor = color(params, 'badgeColor', '#F43F5E')
    const badge = str(params, 'badgeText', '1').trim()
    const env = envelope(t, duration)
    designSpace(ctx, box, SIZE)

    const R = 98
    const out = outroPop(env)
    ctx.scale(out.scale, out.scale)
    mulAlpha(ctx, out.alpha * clamp01(t / 0.08))

    // Ripple rings, one every 0.6 s while the element holds.
    for (let k = 0; k < 64; k++) {
      const start = FIRST_RING + 0.1 + k * 0.6
      if (start > env.outroStart || start > t) break
      drawRipple(ctx, range(t, start, start + 1.4), R, R * 1.65, shade(c, 0.3), 7)
    }

    // Disc.
    const pop = Math.max(spring(t, 1.8, 0.42), 0)
    ctx.save()
    ctx.scale(pop, pop)
    setShadow(ctx, 'rgba(0,0,0,0.35)', 30, 12)
    const g = ctx.createRadialGradient(-R * 0.35, -R * 0.45, R * 0.1, 0, 0, R * 1.05)
    g.addColorStop(0, shade(c, 0.28))
    g.addColorStop(1, shade(c, -0.12))
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.fillStyle = g
    ctx.fill()
    clearShadow(ctx)
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.stroke()

    // Bell: swings from its knob, re-rings every RING_EVERY seconds.
    const since = t - FIRST_RING
    const local = since < 0 ? -1 : since % RING_EVERY
    const ringStart = t - local
    const angle =
      since < 0 || ringStart > env.outroStart ? 0 : 0.5 * dampedSine(local, 2.6, 2.8)
    const s = R * 1.12
    ctx.save()
    ctx.translate(0, -s * 0.4 + R * 0.04)
    ctx.rotate(angle)
    ctx.translate(0, s * 0.4)
    ctx.save()
    ctx.rotate(angle * 0.8)
    ctx.beginPath()
    traceBellClapper(ctx, s)
    ctx.fillStyle = iconColor
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    traceBellBody(ctx, s)
    ctx.fillStyle = iconColor
    ctx.fill()
    ctx.restore()
    ctx.restore()

    // Badge.
    const bp = Math.max(spring(t - 0.65, 2.4, 0.4), 0)
    if (bp > 0) {
      ctx.save()
      ctx.translate(R * 0.7, -R * 0.7)
      ctx.scale(bp, bp)
      const br = badge === '' ? 22 : 34
      setShadow(ctx, 'rgba(0,0,0,0.3)', 10, 4)
      ctx.beginPath()
      ctx.arc(0, 0, br + 6, 0, Math.PI * 2)
      ctx.fillStyle = '#FFFFFF'
      ctx.fill()
      clearShadow(ctx)
      ctx.beginPath()
      ctx.arc(0, 0, br, 0, Math.PI * 2)
      ctx.fillStyle = badgeColor
      ctx.fill()
      if (badge !== '') {
        fitFont(ctx, badge, 800, 38, br * 1.5)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#FFFFFF'
        ctx.fillText(badge, 0, 2)
      }
      ctx.restore()
    }
  },
}
