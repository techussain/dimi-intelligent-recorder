import {
  clearShadow,
  designSpace,
  ease,
  envelope,
  lerp,
  mulAlpha,
  range,
  setShadow,
  shade,
  TAU,
  tracePolyline,
} from '../anim'
import { color, num } from '../params'
import type { ElementTemplate } from '../types'

const SIZE = { w: 480, h: 300 }
const STEPS = 140
// Starts upper-left, sweeps one full turn plus an overshoot past the start.
const START = -2.35
const SWEEP = TAU + 0.55

/** Marker loop in unit space: slightly irregular and spiralling inward. */
function loopPoints(rx: number, ry: number): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS
    const a = START + SWEEP * u
    const wob = 1 + 0.035 * Math.sin(2 * a + 0.8) + 0.02 * Math.sin(3 * a + 2.1)
    const spiral = lerp(1.02, 0.93, u)
    pts.push([Math.cos(a) * rx * wob * spiral, Math.sin(a) * ry * wob * spiral - u * 6])
  }
  return pts
}

export const highlightCircle: ElementTemplate = {
  id: 'highlightCircle',
  name: 'Highlight circle',
  category: 'callout',
  defaultDuration: 3,
  size: SIZE,
  params: [
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'number', key: 'thickness', label: 'Thickness', min: 3, max: 30, step: 1 },
  ],
  defaults: { color: '#F43F5E', thickness: 11 },
  draw(ctx, params, t, duration, box) {
    const c = color(params, 'color', '#F43F5E')
    const lw = num(params, 'thickness', 11)
    const env = envelope(t, duration)
    const ds = designSpace(ctx, box, SIZE)

    const rx = Math.max(ds.w / 2 - lw - 14, 4)
    const ry = Math.max(ds.h / 2 - lw - 14, 4)
    const pts = loopPoints(rx, ry)

    // Subtle hand wobble while it holds; scales up a touch while fading out.
    const wobble = 0.012 * Math.sin(TAU * 0.7 * t)
    const breathe = 1 + 0.01 * Math.sin(TAU * 1.1 * t)
    const outS = 1 + 0.06 * ease.outCubic(env.outro)
    const inS = lerp(1.06, 1, ease.outCubic(range(t, 0, 0.5)))
    ctx.rotate(wobble)
    ctx.scale(breathe * outS * inS, breathe * outS * inS)
    mulAlpha(ctx, 1 - ease.inQuad(env.outro))

    const p = ease.inOutSine(range(t, 0.04, 0.78))
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    setShadow(ctx, 'rgba(0,0,0,0.28)', 8, 2)
    ctx.beginPath()
    tracePolyline(ctx, pts, p)
    ctx.strokeStyle = c
    ctx.lineWidth = lw
    ctx.stroke()
    clearShadow(ctx)

    // Marker sheen: thin lighter stroke riding on the upper edge.
    ctx.save()
    mulAlpha(ctx, 0.45)
    ctx.translate(-lw * 0.12, -lw * 0.18)
    ctx.beginPath()
    tracePolyline(ctx, pts, p)
    ctx.strokeStyle = shade(c, 0.45)
    ctx.lineWidth = Math.max(lw * 0.28, 1)
    ctx.stroke()
    ctx.restore()
  },
}
