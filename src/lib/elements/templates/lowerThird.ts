import {
  clearShadow,
  designSpace,
  ease,
  envelope,
  fitFont,
  font,
  mulAlpha,
  range,
  rgba,
  setShadow,
  shade,
} from '../anim'
import { color, str } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 960, h: 220 }

export const lowerThird: ElementTemplate = {
  id: 'lowerThird',
  name: 'Lower third',
  category: 'title',
  defaultDuration: 5,
  size: SIZE,
  params: [
    { kind: 'text', key: 'name', label: 'Name', maxLength: 60 },
    { kind: 'text', key: 'title', label: 'Title', maxLength: 80 },
    { kind: 'color', key: 'primary', label: 'Accent color' },
    { kind: 'color', key: 'secondary', label: 'Name bar color' },
    { kind: 'color', key: 'textColor', label: 'Text color' },
  ],
  defaults: {
    name: 'Alex Morgan',
    title: 'Product Designer',
    primary: '#7C3AED',
    secondary: '#15151C',
    textColor: '#FFFFFF',
  },
  draw(ctx, params, t, duration, box) {
    const primary = color(params, 'primary', '#7C3AED')
    const secondary = color(params, 'secondary', '#15151C')
    const textColor = color(params, 'textColor', '#FFFFFF')
    const name = str(params, 'name', '')
    const title = str(params, 'title', '')
    // A slightly longer intro/outro: this one is a choreographed sequence.
    const env = envelope(t, duration, 0.8, 0.6)
    const k = env.introLen / 0.8
    const it = t / Math.max(k, 1e-3)
    const ds = designSpace(ctx, box, SIZE)

    const accentW = 12
    const nameH = 88
    const titleH = 52
    const gap = 8
    const hasTitle = title.trim() !== ''
    const totalH = hasTitle ? nameH + gap + titleH : nameH
    const top = -totalH / 2
    const left = -ds.w / 2 + 16
    const maxBarW = ds.w - 32 - accentW - 4

    const nameFs = fitFont(ctx, name, 800, 50, maxBarW - 64)
    const nameW = Math.min(ctx.measureText(name).width + 64, maxBarW)
    const titleFs = fitFont(ctx, title, 600, 30, maxBarW - 48)
    const titleW = Math.min(ctx.measureText(title).width + 48, maxBarW)

    // In: accent grows, then bars wipe out of it. Out: reverse, staggered.
    const o = env.outro
    const accentP =
      ease.outCubic(range(it, 0, 0.32)) * (1 - ease.inCubic(range(o, 0.55, 1)))
    const nameP =
      ease.outQuart(range(it, 0.12, 0.6)) * (1 - ease.inCubic(range(o, 0.2, 0.8)))
    const titleP =
      ease.outQuart(range(it, 0.26, 0.74)) * (1 - ease.inCubic(range(o, 0, 0.6)))
    const nameText = ease.outCubic(range(it, 0.3, 0.75)) * (1 - range(o, 0.1, 0.45))
    const titleText = ease.outCubic(range(it, 0.42, 0.85)) * (1 - range(o, 0, 0.35))

    if (accentP <= 0) return
    const barX = left + accentW + 4

    // Name bar.
    if (nameP > 0) {
      ctx.save()
      setShadow(ctx, 'rgba(0,0,0,0.35)', 24, 8)
      ctx.fillStyle = rgba(secondary, 0.92)
      ctx.fillRect(barX, top, nameW * nameP, nameH)
      clearShadow(ctx)
      ctx.beginPath()
      ctx.rect(barX, top, nameW * nameP, nameH)
      ctx.clip()
      ctx.save()
      mulAlpha(ctx, nameText)
      ctx.font = font(800, nameFs)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = textColor
      ctx.fillText(name, barX + 32 - (1 - nameText) * 36, top + nameH / 2 + 2)
      ctx.restore()
      ctx.restore()
    }

    // Title bar.
    if (hasTitle && titleP > 0) {
      const ty = top + nameH + gap
      ctx.save()
      setShadow(ctx, 'rgba(0,0,0,0.3)', 18, 6)
      const g = ctx.createLinearGradient(barX, 0, barX + titleW, 0)
      g.addColorStop(0, primary)
      g.addColorStop(1, shade(primary, 0.18))
      ctx.fillStyle = g
      ctx.fillRect(barX, ty, titleW * titleP, titleH)
      clearShadow(ctx)
      ctx.beginPath()
      ctx.rect(barX, ty, titleW * titleP, titleH)
      ctx.clip()
      ctx.save()
      mulAlpha(ctx, titleText)
      ctx.font = font(600, titleFs)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = textColor
      ctx.fillText(title, barX + 24 - (1 - titleText) * 28, ty + titleH / 2 + 1)
      ctx.restore()
      ctx.restore()
    }

    // Accent bar grows from the middle.
    ctx.save()
    const ah = totalH * accentP
    setShadow(ctx, 'rgba(0,0,0,0.3)', 14, 4)
    const ag = ctx.createLinearGradient(0, top, 0, top + totalH)
    ag.addColorStop(0, shade(primary, 0.25))
    ag.addColorStop(1, primary)
    ctx.fillStyle = ag
    ctx.fillRect(left, -ah / 2, accentW, ah)
    ctx.restore()
  },
}
