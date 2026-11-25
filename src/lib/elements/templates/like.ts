import {
  beatScale,
  clamp01,
  clearShadow,
  dampedSine,
  designSpace,
  drawBurst,
  drawRipple,
  ease,
  envelope,
  fitFont,
  luminance,
  mulAlpha,
  outroPop,
  range,
  setShadow,
  shade,
  spring,
  traceRoundedRect,
  traceThumbUp,
} from '../anim'
import { color, str } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 360, h: 360 }

export const like: ElementTemplate = {
  id: 'like',
  name: 'Like',
  category: 'social',
  defaultDuration: 3,
  size: SIZE,
  params: [
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'color', key: 'iconColor', label: 'Icon color' },
    { kind: 'text', key: 'label', label: 'Counter', maxLength: 8 },
  ],
  defaults: { color: '#7C3AED', iconColor: '#FFFFFF', label: '+1' },
  draw(ctx, params, t, duration, box) {
    const c = color(params, 'color', '#7C3AED')
    const iconColor = color(params, 'iconColor', '#FFFFFF')
    const label = str(params, 'label', '+1')
    const env = envelope(t, duration)
    const bt = t / beatScale(duration, 1.8)
    designSpace(ctx, box, SIZE)

    const R = 104
    const out = outroPop(env)
    ctx.scale(out.scale, out.scale)
    mulAlpha(ctx, out.alpha * clamp01(bt / 0.1))

    const pressAt = 0.72
    const pop = Math.max(spring(bt, 1.8, 0.4), 0)
    const bump = Math.sin(Math.PI * range(bt, pressAt - 0.06, pressAt + 0.22))

    // Shockwave + particles behind the disc.
    drawRipple(
      ctx,
      range(bt, pressAt + 0.05, pressAt + 0.75),
      R,
      R * 1.6,
      shade(c, 0.35),
      10,
    )
    drawBurst(ctx, range(bt, pressAt + 0.05, pressAt + 0.8), {
      count: 12,
      r0: R * 1.02,
      spread: R * 0.62,
      size: 16,
      colors: [shade(c, 0.45), '#FFFFFF', c],
      seed: 3,
    })

    // Disc.
    ctx.save()
    const ds = pop * (1 + 0.08 * bump)
    ctx.scale(ds, ds)
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

    // Thumb: tilts back, then springs forward on the "press".
    const tilt =
      -0.28 * (1 - ease.outBack(range(bt, 0.1, 0.55))) -
      0.32 * dampedSine(bt - pressAt, 2.2, 5)
    const ts = 1 + 0.16 * bump
    ctx.save()
    ctx.translate(0, R * 0.04)
    ctx.rotate(tilt)
    ctx.scale(ts, ts)
    ctx.beginPath()
    traceThumbUp(ctx, R * 1.04)
    ctx.fillStyle = iconColor
    ctx.fill()
    ctx.restore()
    ctx.restore()

    // "+1" badge floats up.
    if (label.trim() !== '') {
      const lp = range(bt, pressAt + 0.12, pressAt + 0.6)
      if (lp > 0) {
        const lpop = Math.max(spring(bt - pressAt - 0.12, 2.2, 0.45), 0)
        ctx.save()
        ctx.translate(R * 0.78, -R * 0.78 - 26 * ease.outCubic(lp))
        ctx.rotate(0.12)
        ctx.scale(lpop, lpop)
        const fs = fitFont(ctx, label, 800, 40, 130)
        const tw = ctx.measureText(label).width
        const bw = tw + 30
        const bh = fs + 20
        setShadow(ctx, 'rgba(0,0,0,0.3)', 16, 6)
        ctx.beginPath()
        traceRoundedRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2)
        ctx.fillStyle = '#FFFFFF'
        ctx.fill()
        clearShadow(ctx)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = luminance(c) > 0.7 ? '#18181B' : c
        ctx.fillText(label, 0, 2)
        ctx.restore()
      }
    }
  },
}
