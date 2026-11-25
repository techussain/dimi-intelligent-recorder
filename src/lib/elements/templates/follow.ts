import {
  beatScale,
  clamp01,
  clearShadow,
  designSpace,
  ease,
  ellipsize,
  envelope,
  fitFont,
  font,
  lerp,
  mix,
  mulAlpha,
  range,
  rgba,
  setShadow,
  shade,
  spring,
  strokeCheck,
  textWidth,
  traceRoundedRect,
} from '../anim'
import { color, str } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 680, h: 190 }

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

export const follow: ElementTemplate = {
  id: 'follow',
  name: 'Follow card',
  category: 'social',
  defaultDuration: 4,
  size: SIZE,
  params: [
    { kind: 'text', key: 'name', label: 'Name', maxLength: 40 },
    { kind: 'text', key: 'handle', label: 'Handle', maxLength: 40 },
    { kind: 'text', key: 'followText', label: 'Button text', maxLength: 16 },
    { kind: 'text', key: 'followingText', label: 'Clicked text', maxLength: 16 },
    { kind: 'color', key: 'primary', label: 'Accent color' },
    { kind: 'color', key: 'textColor', label: 'Text color' },
  ],
  defaults: {
    name: 'Dimi Studio',
    handle: '@dimistudio',
    followText: 'Follow',
    followingText: 'Following',
    primary: '#7C3AED',
    textColor: '#FFFFFF',
  },
  draw(ctx, params, t, duration, box) {
    const primary = color(params, 'primary', '#7C3AED')
    const textColor = color(params, 'textColor', '#FFFFFF')
    const name = str(params, 'name', '')
    const handle = str(params, 'handle', '')
    const followText = str(params, 'followText', 'Follow')
    const followingText = str(params, 'followingText', 'Following')
    const env = envelope(t, duration)
    const bt = t / beatScale(duration, 2.1)
    const ds = designSpace(ctx, box, SIZE)

    // Layout (design px).
    const H = 150
    const pad = 26
    const avatarD = 96
    const pillH = 62
    const pillPad = 30
    const check = 24
    const nameFs = 36
    const handleFs = 25
    const textW = Math.min(
      400,
      Math.max(
        textWidth(ctx, name, 700, nameFs),
        textWidth(ctx, handle, 500, handleFs),
        60,
      ),
    )
    const pillW = Math.max(
      textWidth(ctx, followText, 700, 28) + pillPad * 2,
      check + 10 + textWidth(ctx, followingText, 700, 28) + pillPad * 2,
    )
    const W = pad + avatarD + 22 + textW + 30 + pillW + pad
    const fit = Math.min(1, (ds.w - 16) / W, (ds.h - 16) / H)
    ctx.scale(fit, fit)

    // Card in / out.
    const cin = ease.outBack(range(bt, 0, 0.5), 1.2)
    const cout = ease.inBack(env.outro, 1.3)
    const cardScale = lerp(0.92, 1, cin) * (1 - 0.12 * cout)
    ctx.translate(0, (1 - ease.outCubic(range(bt, 0, 0.45))) * 26 + cout * 18)
    ctx.scale(cardScale, cardScale)
    mulAlpha(ctx, clamp01(range(bt, 0, 0.25)) * (1 - ease.inQuad(env.outro)))

    const x0 = -W / 2
    setShadow(ctx, 'rgba(0,0,0,0.4)', 32, 12)
    ctx.beginPath()
    traceRoundedRect(ctx, x0, -H / 2, W, H, 30)
    ctx.fillStyle = 'rgba(20,20,27,0.9)'
    ctx.fill()
    clearShadow(ctx)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'
    ctx.stroke()

    // Avatar.
    const ap = Math.max(spring(bt - 0.12, 2, 0.45), 0)
    const ax = x0 + pad + avatarD / 2
    ctx.save()
    ctx.translate(ax, 0)
    ctx.scale(ap, ap)
    const ag = ctx.createLinearGradient(
      -avatarD / 2,
      -avatarD / 2,
      avatarD / 2,
      avatarD / 2,
    )
    ag.addColorStop(0, shade(primary, 0.35))
    ag.addColorStop(1, shade(primary, -0.2))
    ctx.beginPath()
    ctx.arc(0, 0, avatarD / 2, 0, Math.PI * 2)
    ctx.fillStyle = ag
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.stroke()
    const ini = initials(name)
    fitFont(ctx, ini, 800, 38, avatarD * 0.66)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(ini, 0, 2)
    ctx.restore()

    // Name + handle.
    const tx = ax + avatarD / 2 + 22
    const tp = ease.outCubic(range(bt, 0.2, 0.62))
    ctx.save()
    mulAlpha(ctx, tp)
    ctx.translate((1 - tp) * -18, 0)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    fitFont(ctx, name, 700, nameFs, textW, 0.75)
    ctx.fillStyle = textColor
    ctx.fillText(ellipsize(ctx, name, textW), tx, handle ? -17 : 0)
    if (handle) {
      fitFont(ctx, handle, 500, handleFs, textW, 0.8)
      ctx.fillStyle = rgba(textColor, 0.6)
      ctx.fillText(ellipsize(ctx, handle, textW), tx, 23)
    }
    ctx.restore()

    // Follow pill.
    const pp = Math.max(spring(bt - 0.35, 2.1, 0.45), 0)
    const press = Math.sin(Math.PI * range(bt, 1.3, 1.52))
    const sw = ease.outCubic(range(bt, 1.4, 1.65))
    const px = x0 + W - pad - pillW / 2
    ctx.save()
    ctx.translate(px, 0)
    const ps = pp * (1 - 0.07 * press)
    ctx.scale(ps, ps)
    ctx.beginPath()
    traceRoundedRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, pillH / 2)
    ctx.fillStyle = mix(primary, '#2A2A33', sw)
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = `rgba(255,255,255,${(0.08 + 0.22 * sw).toFixed(3)})`
    ctx.stroke()
    ctx.save()
    ctx.beginPath()
    traceRoundedRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, pillH / 2)
    ctx.clip()
    ctx.textBaseline = 'middle'
    if (sw < 1) {
      ctx.save()
      mulAlpha(ctx, 1 - Math.min(1, sw * 1.8))
      ctx.font = font(700, 28)
      ctx.textAlign = 'center'
      ctx.fillStyle = '#FFFFFF'
      ctx.fillText(followText, 0, 2 - sw * pillH * 0.6)
      ctx.restore()
    }
    if (sw > 0) {
      ctx.save()
      mulAlpha(ctx, sw)
      const w = check + 10 + textWidth(ctx, followingText, 700, 28)
      ctx.translate(-w / 2, (1 - sw) * pillH * 0.6)
      ctx.save()
      ctx.translate(check / 2, 0)
      strokeCheck(ctx, check, ease.outCubic(range(bt, 1.5, 1.85)), '#FFFFFF', 4.5)
      ctx.restore()
      ctx.font = font(700, 28)
      ctx.textAlign = 'left'
      ctx.fillStyle = '#FFFFFF'
      ctx.fillText(followingText, check + 10, 2)
      ctx.restore()
    }
    ctx.restore()
    ctx.restore()

    // Confirmation pulse: the pill outline expands and fades.
    const pulse = range(bt, 1.42, 2.05)
    if (pulse > 0 && pulse < 1) {
      const e = ease.outCubic(pulse)
      const grow = 16 * e
      ctx.save()
      ctx.translate(px, 0)
      mulAlpha(ctx, 1 - pulse)
      ctx.beginPath()
      traceRoundedRect(
        ctx,
        -pillW / 2 - grow,
        -pillH / 2 - grow,
        pillW + grow * 2,
        pillH + grow * 2,
        pillH / 2 + grow,
      )
      ctx.strokeStyle = shade(primary, 0.4)
      ctx.lineWidth = 4 * (1 - 0.6 * pulse)
      ctx.stroke()
      ctx.restore()
    }
  },
}
