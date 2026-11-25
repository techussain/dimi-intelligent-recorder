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
  font,
  lerp,
  mix,
  mulAlpha,
  outroPop,
  range,
  setShadow,
  shade,
  spring,
  strokeCheck,
  textWidth,
  traceBellBody,
  traceBellClapper,
  traceCursor,
  traceRoundedRect,
} from '../anim'
import { color, str } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 640, h: 200 }
const DONE = '#3A3B44'
const DONE_TEXT = '#E9E9EE'

/** Bell button next to the pill: rings after the click. */
function drawBellButton(
  ctx: CanvasRenderingContext2D,
  d: number,
  angle: number,
  shake: number,
): void {
  ctx.beginPath()
  ctx.arc(0, 0, d / 2, 0, Math.PI * 2)
  ctx.fillStyle = DONE
  ctx.fill()
  clearShadow(ctx)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.stroke()
  const s = d * 0.56
  // Vibration ticks while ringing.
  if (shake > 0.05) {
    ctx.save()
    mulAlpha(ctx, clamp01(shake * 1.6))
    ctx.strokeStyle = DONE_TEXT
    ctx.lineWidth = d * 0.045
    ctx.lineCap = 'round'
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.arc(
        0,
        -s * 0.05,
        s * 0.68,
        side < 0 ? Math.PI * 1.08 : -0.28,
        side < 0 ? Math.PI * 1.28 : -0.08,
      )
      ctx.stroke()
    }
    ctx.restore()
  }
  ctx.save()
  ctx.translate(0, -s * 0.4)
  ctx.rotate(angle)
  ctx.translate(0, s * 0.4)
  ctx.save()
  ctx.translate(0, -s * 0.03)
  ctx.rotate(angle * 0.9)
  ctx.beginPath()
  traceBellClapper(ctx, s)
  ctx.fillStyle = DONE_TEXT
  ctx.fill()
  ctx.restore()
  ctx.beginPath()
  traceBellBody(ctx, s)
  ctx.fillStyle = DONE_TEXT
  ctx.fill()
  ctx.restore()
}

export const subscribe: ElementTemplate = {
  id: 'subscribe',
  name: 'Subscribe button',
  category: 'social',
  defaultDuration: 4.5,
  size: SIZE,
  params: [
    { kind: 'text', key: 'text', label: 'Button text', maxLength: 24 },
    { kind: 'text', key: 'subscribedText', label: 'Clicked text', maxLength: 24 },
    { kind: 'color', key: 'primary', label: 'Button color' },
    { kind: 'color', key: 'textColor', label: 'Text color' },
  ],
  // Subscribe buttons are traditionally red (try #E11D48); we default to the
  // brand purple so it matches the rest of the app's look.
  defaults: {
    text: 'SUBSCRIBE',
    subscribedText: 'SUBSCRIBED',
    primary: '#7C3AED',
    textColor: '#FFFFFF',
  },
  draw(ctx, params, t, duration, box) {
    const primary = color(params, 'primary', '#7C3AED')
    const textColor = color(params, 'textColor', '#FFFFFF')
    const label = str(params, 'text', 'SUBSCRIBE')
    const doneLabel = str(params, 'subscribedText', 'SUBSCRIBED')
    const env = envelope(t, duration)
    const bt = t / beatScale(duration, 3.2)

    const ds = designSpace(ctx, box, SIZE)
    const H = 92
    const fs = 38
    const padX = 42
    const check = 30
    const gap = 18
    const bellD = H
    const w0 = textWidth(ctx, label, 800, fs) + padX * 2
    const w1 = check + 12 + textWidth(ctx, doneLabel, 800, fs) + padX * 2
    const maxGroup = Math.max(w0, w1) + gap + bellD
    const fit = Math.min(1, (ds.w - 24) / maxGroup, (ds.h - 8) / (H + 70))
    ctx.scale(fit, fit)

    // Beats.
    const pop = spring(bt, 1.9, 0.42)
    const sw = ease.outCubic(range(bt, 1.38, 1.58))
    const press = Math.sin(Math.PI * range(bt, 1.24, 1.5))
    const bellIn = ease.outCubic(range(bt, 1.55, 1.95))
    const bellPop = spring(bt - 1.55, 2.2, 0.4)
    const ringT = bt - 1.8
    const ringAngle = 0.42 * dampedSine(ringT, 3.2, 2.6)
    const ringShake = ringT > 0 ? Math.exp(-2.6 * ringT) : 0

    const pillW = lerp(w0, w1, sw)
    const groupW = pillW + (gap + bellD) * bellIn
    const pillX = -groupW / 2
    const pillCx = pillX + pillW / 2

    const out = outroPop(env)
    ctx.scale(out.scale, out.scale)
    mulAlpha(ctx, out.alpha * clamp01(bt / 0.12))

    // ---- Pill
    ctx.save()
    const pillScale = Math.max(pop, 0) * (1 - 0.06 * press)
    ctx.translate(pillCx, 0)
    ctx.scale(pillScale, pillScale)
    setShadow(ctx, 'rgba(0,0,0,0.38)', 26, 10)
    const grad = ctx.createLinearGradient(0, -H / 2, 0, H / 2)
    grad.addColorStop(0, mix(shade(primary, 0.14), DONE, sw))
    grad.addColorStop(1, mix(shade(primary, -0.1), DONE, sw))
    ctx.beginPath()
    traceRoundedRect(ctx, -pillW / 2, -H / 2, pillW, H, H / 2)
    ctx.fillStyle = grad
    ctx.fill()
    clearShadow(ctx)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.stroke()

    // Clip the labels to the pill so they can slide.
    ctx.save()
    ctx.beginPath()
    traceRoundedRect(ctx, -pillW / 2, -H / 2, pillW, H, H / 2)
    ctx.clip()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (sw < 1) {
      ctx.save()
      mulAlpha(ctx, 1 - Math.min(1, sw * 1.8))
      ctx.font = font(800, fs)
      ctx.fillStyle = textColor
      ctx.fillText(label, 0, -H * 0.6 * sw + 2)
      ctx.restore()
    }
    if (sw > 0) {
      ctx.save()
      mulAlpha(ctx, sw)
      const y = H * 0.6 * (1 - sw)
      const tw = w1 - padX * 2
      ctx.translate(-tw / 2, y)
      ctx.save()
      ctx.translate(check / 2, 0)
      strokeCheck(ctx, check, ease.outCubic(range(bt, 1.5, 1.85)), DONE_TEXT, 6)
      ctx.restore()
      ctx.font = font(800, fs)
      ctx.textAlign = 'left'
      ctx.fillStyle = DONE_TEXT
      ctx.fillText(doneLabel, check + 12, 2)
      ctx.restore()
    }
    ctx.restore()
    ctx.restore()

    // Click ripple.
    const clickX = pillCx + w0 * 0.18
    const clickY = 8
    ctx.save()
    ctx.translate(clickX, clickY)
    drawRipple(ctx, range(bt, 1.32, 1.95), 6, 70, 'rgba(255,255,255,0.85)', 5)
    drawBurst(ctx, range(bt, 1.34, 1.9), {
      count: 8,
      r0: 26,
      spread: 46,
      size: 9,
      colors: ['#FFFFFF', shade(primary, 0.45)],
      seed: 11,
      streaks: true,
    })
    ctx.restore()

    // ---- Bell
    if (bellIn > 0) {
      ctx.save()
      ctx.translate(pillX + pillW + gap + bellD / 2, 0)
      const bs = Math.max(bellPop, 0)
      ctx.scale(bs, bs)
      setShadow(ctx, 'rgba(0,0,0,0.35)', 22, 8)
      drawBellButton(ctx, bellD, ringAngle, ringShake)
      ctx.restore()
    }

    // ---- Cursor: glides in, clicks, leaves.
    const enter = ease.inOutCubic(range(bt, 0.45, 1.22))
    const leave = ease.inCubic(range(bt, 2.15, 2.75))
    const curAlpha = clamp01(range(bt, 0.45, 0.7)) * (1 - leave)
    if (curAlpha > 0) {
      const sx = clickX + 230
      const sy = clickY + 150
      const arc = Math.sin(Math.PI * enter) * -40
      const x = lerp(sx, clickX, enter) + leave * 160
      const y = lerp(sy, clickY, enter) + arc + leave * 110
      const cs = 58 * (1 - 0.16 * press)
      ctx.save()
      mulAlpha(ctx, curAlpha)
      ctx.translate(x, y)
      ctx.rotate(-0.12)
      setShadow(ctx, 'rgba(0,0,0,0.4)', 12, 4)
      ctx.beginPath()
      traceCursor(ctx, cs)
      ctx.fillStyle = '#FFFFFF'
      ctx.fill()
      clearShadow(ctx)
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3.5
      ctx.strokeStyle = '#111114'
      ctx.stroke()
      ctx.restore()
    }
  },
}
