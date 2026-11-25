import {
  clamp,
  clamp01,
  clearShadow,
  designSpace,
  drawBurst,
  drawRipple,
  ease,
  envelope,
  fitFont,
  lerp,
  mix,
  mulAlpha,
  outroPop,
  range,
  rgba,
  setShadow,
  shade,
  spring,
} from '../anim'
import { color, num, str } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 400, h: 400 }

export const countdown: ElementTemplate = {
  id: 'countdown',
  name: 'Countdown',
  category: 'timer',
  defaultDuration: 4,
  size: SIZE,
  params: [
    { kind: 'number', key: 'from', label: 'Count from', min: 1, max: 10, step: 1 },
    { kind: 'text', key: 'endText', label: 'End text', maxLength: 12 },
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'color', key: 'textColor', label: 'Text color' },
  ],
  defaults: { from: 3, endText: 'GO!', color: '#7C3AED', textColor: '#FFFFFF' },
  draw(ctx, params, t, duration, box) {
    const c = color(params, 'color', '#7C3AED')
    const textColor = color(params, 'textColor', '#FFFFFF')
    const from = Math.round(clamp(num(params, 'from', 3), 1, 99))
    const endText = str(params, 'endText', 'GO!').trim()
    const env = envelope(t, duration)
    designSpace(ctx, box, SIZE)

    // Each number (and the end text) gets an equal slice of the clip.
    const steps = from + (endText ? 1 : 0)
    const stepLen = Math.max(duration, 0.001) / steps
    const idx = clamp(Math.floor(t / stepLen), 0, steps - 1)
    const local = t - idx * stepLen
    const u = clamp01(local / stepLen)
    const isEnd = endText !== '' && idx === steps - 1

    const R = 128
    const ringR = 148
    const out = outroPop(env)
    ctx.scale(out.scale, out.scale)
    mulAlpha(ctx, out.alpha * clamp01(t / 0.08))

    // Tick ripple at every step.
    drawRipple(
      ctx,
      range(local, 0, 0.7),
      ringR,
      ringR + 26,
      rgba(shade(c, 0.4), 0.9),
      6,
    )

    // Disc.
    const pop = Math.max(spring(t, 1.8, 0.6), 0)
    const endFill = isEnd ? ease.outCubic(range(local, 0, 0.25)) : 0
    ctx.save()
    ctx.scale(pop, pop)
    setShadow(ctx, 'rgba(0,0,0,0.4)', 30, 12)
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.fillStyle = mix('#121218', c, endFill, lerp(0.86, 1, endFill))
    ctx.fill()
    clearShadow(ctx)

    // Ring track + remaining-time arc (drains clockwise each step).
    ctx.lineCap = 'round'
    ctx.lineWidth = 14
    ctx.beginPath()
    ctx.arc(0, 0, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.stroke()
    const remain = isEnd ? 1 : 1 - ease.inOutSine(u)
    if (remain > 0.002) {
      ctx.beginPath()
      ctx.arc(0, 0, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remain)
      ctx.strokeStyle = isEnd ? shade(c, 0.35) : c
      ctx.stroke()
    }
    ctx.restore()

    // Burst behind the end text.
    if (isEnd) {
      drawBurst(ctx, range(local, 0.02, 0.7), {
        count: 14,
        r0: ringR + 6,
        spread: 30,
        size: 12,
        colors: [shade(c, 0.5), '#FFFFFF', c],
        seed: 7,
        streaks: true,
      })
    }

    // Number / end text: punches in from large, shrinks away at the end.
    const label = isEnd ? endText : String(from - idx)
    const inP = isEnd
      ? Math.max(spring(local, 2.2, 0.38), 0)
      : ease.outBack(range(u, 0, 0.3), 2)
    const outP = isEnd ? 0 : ease.inCubic(range(u, 0.82, 1))
    const s = (isEnd ? lerp(0.35, 1, inP) : lerp(1.45, 1, inP)) * (1 - 0.35 * outP)
    ctx.save()
    mulAlpha(
      ctx,
      (isEnd ? 1 : lerp(0.4, 1, range(u, 0, 0.1))) * (1 - outP) * clamp01(pop),
    )
    ctx.scale(s, s)
    const fs = fitFont(ctx, label, 800, isEnd ? 110 : 168, R * 1.55)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = textColor
    setShadow(ctx, 'rgba(0,0,0,0.25)', 10, 3)
    ctx.fillText(label, 0, fs * 0.04)
    ctx.restore()
  },
}
