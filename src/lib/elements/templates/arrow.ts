import {
  clamp01,
  clearShadow,
  dampedSine,
  designSpace,
  ease,
  envelope,
  mulAlpha,
  noise1,
  range,
  sampleCubic,
  setShadow,
  tracePolyline,
} from '../anim'
import { color, num, str } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 420, h: 300 }
// Half-extents of the drawn arrow (pointing right) in design px.
const EXT_X = 195
const EXT_Y = 90

type Pt = [number, number]

/** Hand-drawn body: a swooping cubic with a gentle perpendicular wobble. */
function bodyPoints(): Pt[] {
  const raw = sampleCubic([-170, 66], [-118, -84], [62, -92], [160, -12], 64)
  return raw.map((p, i) => {
    const prev = raw[Math.max(i - 1, 0)] ?? p
    const next = raw[Math.min(i + 1, raw.length - 1)] ?? p
    const dx = next[0] - prev[0]
    const dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy) || 1
    const w = 2.6 * noise1(i * 0.32, 4) * Math.sin((Math.PI * i) / (raw.length - 1))
    return [p[0] + (-dy / len) * w, p[1] + (dx / len) * w]
  })
}

const BODY = bodyPoints()

export const arrow: ElementTemplate = {
  id: 'arrow',
  name: 'Hand-drawn arrow',
  category: 'callout',
  defaultDuration: 3,
  size: SIZE,
  params: [
    { kind: 'color', key: 'color', label: 'Color' },
    {
      kind: 'text',
      key: 'direction',
      label: 'Direction',
      options: [
        { value: 'right', label: 'Right' },
        { value: 'left', label: 'Left' },
        { value: 'up', label: 'Up' },
        { value: 'down', label: 'Down' },
      ],
    },
    { kind: 'number', key: 'thickness', label: 'Thickness', min: 4, max: 32, step: 1 },
  ],
  defaults: { color: '#7C3AED', direction: 'right', thickness: 14 },
  draw(ctx, params, t, duration, box) {
    const c = color(params, 'color', '#7C3AED')
    const dir = str(params, 'direction', 'right')
    const lw = num(params, 'thickness', 14)
    const env = envelope(t, duration)
    const ds = designSpace(ctx, box, SIZE)

    const vertical = dir === 'up' || dir === 'down'
    const ex = (vertical ? EXT_Y : EXT_X) + lw
    const ey = (vertical ? EXT_X : EXT_Y) + lw
    const fit = Math.min(1, ds.w / (2 * ex), ds.h / (2 * ey))
    ctx.scale(fit, fit)
    if (dir === 'left') ctx.scale(-1, 1)
    else if (dir === 'up') ctx.rotate(-Math.PI / 2)
    else if (dir === 'down') ctx.rotate(Math.PI / 2)

    const tip = BODY[BODY.length - 1] ?? [160, -12]
    const before = BODY[BODY.length - 4] ?? [140, -24]
    const ang = Math.atan2(tip[1] - before[1], tip[0] - before[0])
    const ux = Math.cos(ang)
    const uy = Math.sin(ang)

    // Nudge toward the target once drawn: an arrival bounce, then a gentle pulse.
    const drawn = 0.85
    const nudge =
      t < drawn
        ? 0
        : -9 * dampedSine(t - drawn, 2.4, 4) +
          7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 1.1 * Math.max(t - drawn - 0.5, 0)))
    ctx.translate(ux * nudge, uy * nudge)

    mulAlpha(ctx, 1 - ease.inQuad(range(env.outro, 0.5, 1)))
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = c
    ctx.lineWidth = lw
    setShadow(ctx, 'rgba(0,0,0,0.35)', 10, 3)

    const drawP = ease.inOutCubic(range(t, 0.05, 0.62))
    const eraseP = ease.inCubic(env.outro)

    // Body: draws on from the tail; erases from the tail during the outro.
    ctx.beginPath()
    if (eraseP > 0) {
      tracePolyline(ctx, [...BODY].reverse(), 1 - eraseP)
    } else {
      tracePolyline(ctx, BODY, drawP)
    }
    ctx.stroke()

    // Head: two strokes flick out from the tip.
    const headP = ease.outBack(range(t, 0.55, 0.8), 2)
    const headA = 1 - clamp01(eraseP * 2.5)
    if (headP > 0 && headA > 0) {
      ctx.save()
      mulAlpha(ctx, headA)
      const len = 46 + lw * 0.8
      for (const side of [-1, 1]) {
        const a = ang + Math.PI + side * 0.52
        ctx.beginPath()
        ctx.moveTo(tip[0], tip[1])
        ctx.lineTo(
          tip[0] + Math.cos(a) * len * headP,
          tip[1] + Math.sin(a) * len * headP,
        )
        ctx.stroke()
      }
      ctx.restore()
    }
    clearShadow(ctx)
  },
}
