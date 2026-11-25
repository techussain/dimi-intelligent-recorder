/**
 * Shared animation + drawing helpers for element templates. Everything here
 * is pure and deterministic (no Date.now / Math.random) so a frame at time t
 * is identical in preview and export.
 */
import type { ElementBox } from './types'

// ---------------------------------------------------------------------------
// Math + easing

export const TAU = Math.PI * 2

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1)
}

export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p
}

/** Linear 0→1 progress of `t` through [a, b] (clamped). */
export function range(t: number, a: number, b: number): number {
  if (b <= a) return t >= b ? 1 : 0
  return clamp01((t - a) / (b - a))
}

export const ease = {
  linear: (p: number) => p,
  inQuad: (p: number) => p * p,
  outQuad: (p: number) => 1 - (1 - p) * (1 - p),
  inCubic: (p: number) => p * p * p,
  outCubic: (p: number) => 1 - Math.pow(1 - p, 3),
  inOutCubic: (p: number) =>
    p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2,
  outQuart: (p: number) => 1 - Math.pow(1 - p, 4),
  outExpo: (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  inOutSine: (p: number) => -(Math.cos(Math.PI * p) - 1) / 2,
  /** Overshoots past 1 then settles (CSS-style "back" easing). */
  outBack: (p: number, s = 1.70158) => {
    const q = p - 1
    return 1 + (s + 1) * q * q * q + s * q * q
  },
  inBack: (p: number, s = 1.70158) => (s + 1) * p * p * p - s * p * p,
} as const

/**
 * Damped spring from 0 to 1 (under-damped → overshoot). `t` in seconds.
 * `freq` is the oscillation frequency in Hz, `damping` the damping ratio (0..1).
 */
export function spring(t: number, freq = 2.2, damping = 0.45): number {
  if (t <= 0) return 0
  const w = TAU * freq
  const zeta = clamp(damping, 0.01, 0.99)
  const wd = w * Math.sqrt(1 - zeta * zeta)
  const decay = Math.exp(-zeta * w * t)
  return 1 - decay * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t))
}

/** Decaying oscillation starting at 0: amplitude 1 → 0. Good for wiggles. */
export function dampedSine(t: number, freq: number, decay: number): number {
  if (t <= 0) return 0
  return Math.sin(TAU * freq * t) * Math.exp(-decay * t)
}

/** Deterministic hash → [0, 1). */
export function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123
  return x - Math.floor(x)
}

/** Smooth deterministic 1D value noise in [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return lerp(hash(i + seed * 57.3), hash(i + 1 + seed * 57.3), u) * 2 - 1
}

// ---------------------------------------------------------------------------
// Intro / hold / outro envelope

export const INTRO = 0.5
export const OUTRO = 0.4

export interface Envelope {
  /** 0→1 linear progress through the intro. */
  intro: number
  /** 0→1 linear progress through the outro (0 until the outro starts). */
  outro: number
  /** Seconds since the outro started (negative before). */
  outroT: number
  /** Effective intro/outro lengths (shortened for very short clips). */
  introLen: number
  outroLen: number
  /** Time at which the outro begins. */
  outroStart: number
}

export function envelope(
  t: number,
  duration: number,
  intro = INTRO,
  outro = OUTRO,
): Envelope {
  const d = Math.max(duration, 0.001)
  // Short clips: intro + outro share at most 80% of the clip.
  const k = Math.min(1, (d * 0.8) / (intro + outro))
  const introLen = intro * k
  const outroLen = outro * k
  const outroStart = d - outroLen
  return {
    intro: range(t, 0, introLen),
    outro: range(t, outroStart, d),
    outroT: t - outroStart,
    introLen,
    outroLen,
    outroStart,
  }
}

/**
 * Time-compression factor for templates with a scripted sequence of beats:
 * when the clip is shorter than `needed` seconds (+ outro) the beats are
 * squeezed so the whole story still plays. Divide `t` by it.
 */
export function beatScale(duration: number, needed: number): number {
  const avail = Math.max(duration - OUTRO, 0.2)
  return Math.min(1, avail / needed)
}

/** Standard pop-out used by most templates: scale + fade. */
export function outroPop(env: Envelope): { scale: number; alpha: number } {
  const p = env.outro
  return { scale: 1 - 0.25 * ease.inBack(p, 1.4), alpha: 1 - ease.inQuad(p) }
}

// ---------------------------------------------------------------------------
// Context helpers

export const ELEMENT_FONT_FAMILY = '"Inter Variable", Inter, system-ui, sans-serif'

export function font(weight: number, size: number): string {
  return `${weight} ${Math.max(size, 0.5).toFixed(2)}px ${ELEMENT_FONT_FAMILY}`
}

/** Largest font size ≤ `size` at which `text` fits in `maxW`. Sets ctx.font. */
export function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  size: number,
  maxW: number,
  minRatio = 0.3,
): number {
  ctx.font = font(weight, size)
  const w = ctx.measureText(text).width
  const fitted = w > maxW && w > 0 ? Math.max(size * (maxW / w), size * minRatio) : size
  ctx.font = font(weight, fitted)
  return fitted
}

/** Truncate `text` with an ellipsis so it fits `maxW` in the current font. */
export function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (ctx.measureText(text).width <= maxW) return text
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(chars.slice(0, mid).join('').trimEnd() + '…').width <= maxW)
      lo = mid
    else hi = mid - 1
  }
  return chars.slice(0, lo).join('').trimEnd() + '…'
}

export function textWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  size: number,
): number {
  ctx.font = font(weight, size)
  return ctx.measureText(text).width
}

/** Device px per context unit (shadows ignore the transform, so scale them). */
export function pxScale(ctx: CanvasRenderingContext2D): number {
  if (typeof ctx.getTransform !== 'function') return 1
  const m = ctx.getTransform()
  const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
  return Number.isFinite(s) && s > 0 ? s : 1
}

export function setShadow(
  ctx: CanvasRenderingContext2D,
  color: string,
  blur: number,
  offsetY = 0,
): void {
  const s = pxScale(ctx)
  ctx.shadowColor = color
  ctx.shadowBlur = blur * s
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = offsetY * s
}

export function clearShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = 'rgba(0,0,0,0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
}

/** Multiply (never overwrite) the current alpha. */
export function mulAlpha(ctx: CanvasRenderingContext2D, a: number): void {
  ctx.globalAlpha = ctx.globalAlpha * clamp01(a)
}

/**
 * Uniformly scale the context so a template can draw in its intrinsic design
 * units (`size`, 1080p px). Returns the box expressed in design units — wider
 * or taller than `size` when the box has a different aspect ratio.
 */
export function designSpace(
  ctx: CanvasRenderingContext2D,
  box: ElementBox,
  size: { w: number; h: number },
): { s: number; w: number; h: number } {
  const s = Math.max(Math.min(box.w / size.w, box.h / size.h), 1e-6)
  ctx.scale(s, s)
  return { s, w: box.w / s, h: box.h / s }
}

export function traceRoundedRect(
  p: CanvasPath,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = clamp(r, 0, Math.min(Math.abs(w), Math.abs(h)) / 2)
  p.moveTo(x + rr, y)
  p.lineTo(x + w - rr, y)
  p.arcTo(x + w, y, x + w, y + rr, rr)
  p.lineTo(x + w, y + h - rr)
  p.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  p.lineTo(x + rr, y + h)
  p.arcTo(x, y + h, x, y + h - rr, rr)
  p.lineTo(x, y + rr)
  p.arcTo(x, y, x + rr, y, rr)
  p.closePath()
}

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string | CanvasGradient,
): void {
  ctx.beginPath()
  traceRoundedRect(ctx, x, y, w, h, r)
  ctx.fillStyle = fill
  ctx.fill()
}

// ---------------------------------------------------------------------------
// Colors

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m?.[1]) return null
  let h = m[1]
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && parseHex(v) !== null
}

export function rgba(hex: string, a = 1): string {
  const c = parseHex(hex) ?? [124, 58, 237]
  return `rgba(${c[0]},${c[1]},${c[2]},${clamp01(a).toFixed(3)})`
}

/**
 * Mix two hex colors; p=0 → a, p=1 → b. Returns `#rrggbb` when opaque (so the
 * result can be mixed/shaded again), else an `rgba()` string.
 */
export function mix(a: string, b: string, p: number, alpha = 1): string {
  const ca = parseHex(a) ?? [0, 0, 0]
  const cb = parseHex(b) ?? [0, 0, 0]
  const q = clamp01(p)
  const ch = (i: 0 | 1 | 2) => Math.round(lerp(ca[i], cb[i], q))
  if (alpha >= 1) {
    const n = (ch(0) << 16) | (ch(1) << 8) | ch(2)
    return `#${n.toString(16).padStart(6, '0')}`
  }
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${clamp01(alpha).toFixed(3)})`
}

export function shade(hex: string, amount: number): string {
  return amount >= 0 ? mix(hex, '#ffffff', amount) : mix(hex, '#000000', -amount)
}

/** Relative luminance 0..1 — pick readable text on a colored fill. */
export function luminance(hex: string): number {
  const c = parseHex(hex) ?? [0, 0, 0]
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

// ---------------------------------------------------------------------------
// Icons — traced as paths in a unit box centered on (0, 0) spanning ±0.5.
// They accept any CanvasPath, so they work with a context or a Path2D.

export function traceBellBody(p: CanvasPath, s: number): void {
  p.moveTo(0, -0.36 * s)
  p.bezierCurveTo(-0.19 * s, -0.36 * s, -0.29 * s, -0.22 * s, -0.29 * s, -0.04 * s)
  p.lineTo(-0.29 * s, 0.1 * s)
  p.quadraticCurveTo(-0.3 * s, 0.19 * s, -0.4 * s, 0.25 * s)
  p.quadraticCurveTo(-0.43 * s, 0.3 * s, -0.37 * s, 0.3 * s)
  p.lineTo(0.37 * s, 0.3 * s)
  p.quadraticCurveTo(0.43 * s, 0.3 * s, 0.4 * s, 0.25 * s)
  p.quadraticCurveTo(0.3 * s, 0.19 * s, 0.29 * s, 0.1 * s)
  p.lineTo(0.29 * s, -0.04 * s)
  p.bezierCurveTo(0.29 * s, -0.22 * s, 0.19 * s, -0.36 * s, 0, -0.36 * s)
  p.closePath()
  // Knob on top.
  p.moveTo(0.06 * s, -0.4 * s)
  p.arc(0, -0.4 * s, 0.06 * s, 0, TAU)
}

export function traceBellClapper(p: CanvasPath, s: number): void {
  p.moveTo(0.1 * s, 0.33 * s)
  p.arc(0, 0.33 * s, 0.1 * s, 0, Math.PI)
  p.closePath()
}

export function traceThumbUp(p: CanvasPath, s: number): void {
  // Cuff.
  traceRoundedRect(p, -0.44 * s, -0.04 * s, 0.17 * s, 0.44 * s, 0.04 * s)
  // Hand.
  p.moveTo(-0.21 * s, 0.4 * s)
  p.lineTo(-0.21 * s, -0.02 * s)
  p.quadraticCurveTo(-0.13 * s, -0.08 * s, -0.06 * s, -0.2 * s)
  p.lineTo(0.0 * s, -0.36 * s)
  p.quadraticCurveTo(0.04 * s, -0.46 * s, 0.12 * s, -0.42 * s)
  p.quadraticCurveTo(0.19 * s, -0.37 * s, 0.16 * s, -0.25 * s)
  p.lineTo(0.12 * s, -0.08 * s)
  p.lineTo(0.33 * s, -0.08 * s)
  p.quadraticCurveTo(0.46 * s, -0.07 * s, 0.43 * s, 0.06 * s)
  p.lineTo(0.37 * s, 0.31 * s)
  p.quadraticCurveTo(0.34 * s, 0.4 * s, 0.24 * s, 0.4 * s)
  p.closePath()
}

/** Mouse pointer with its tip at (0, 0), pointing up-left. `s` ≈ height. */
export function traceCursor(p: CanvasPath, s: number): void {
  p.moveTo(0, 0)
  p.lineTo(0, 0.76 * s)
  p.lineTo(0.19 * s, 0.6 * s)
  p.lineTo(0.31 * s, 0.88 * s)
  p.lineTo(0.43 * s, 0.83 * s)
  p.lineTo(0.31 * s, 0.56 * s)
  p.lineTo(0.55 * s, 0.55 * s)
  p.closePath()
}

/** Points along a polyline, cut at `progress` (0..1) of its total length. */
export function tracePolyline(
  p: CanvasPath,
  pts: readonly (readonly [number, number])[],
  progress = 1,
): [number, number] | null {
  const first = pts[0]
  if (!first || progress <= 0) return null
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (a && b) total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  let remaining = total * clamp01(progress)
  p.moveTo(first[0], first[1])
  let end: [number, number] = [first[0], first[1]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (!a || !b) continue
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len >= remaining) {
      const q = len > 0 ? remaining / len : 1
      end = [lerp(a[0], b[0], q), lerp(a[1], b[1], q)]
      p.lineTo(end[0], end[1])
      return end
    }
    p.lineTo(b[0], b[1])
    end = [b[0], b[1]]
    remaining -= len
  }
  return end
}

/** Check mark stroked from the short leg to the long leg. */
export function checkPoints(s: number): [number, number][] {
  return [
    [-0.32 * s, 0.02 * s],
    [-0.1 * s, 0.24 * s],
    [0.34 * s, -0.22 * s],
  ]
}

export function strokeCheck(
  ctx: CanvasRenderingContext2D,
  s: number,
  progress: number,
  color: string,
  width: number,
): void {
  if (progress <= 0) return
  ctx.beginPath()
  tracePolyline(ctx, checkPoints(s), progress)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
}

/** Sample a cubic Bézier into `n + 1` points. */
export function sampleCubic(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  n: number,
): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const v = 1 - u
    const a = v * v * v
    const b = 3 * v * v * u
    const c = 3 * v * u * u
    const d = u * u * u
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ])
  }
  return out
}

// ---------------------------------------------------------------------------
// Effects

export interface BurstOptions {
  count: number
  /** Radius where particles start. */
  r0: number
  /** Distance they travel. */
  spread: number
  /** Particle size at start. */
  size: number
  colors: readonly string[]
  seed: number
  /** Draw short streaks instead of dots. */
  streaks?: boolean
}

/** Radial particle burst; `p` is 0→1 progress of the burst. */
export function drawBurst(
  ctx: CanvasRenderingContext2D,
  p: number,
  o: BurstOptions,
): void {
  if (p <= 0 || p >= 1 || o.colors.length === 0) return
  const travel = ease.outCubic(p)
  const fade = 1 - ease.inQuad(p)
  for (let i = 0; i < o.count; i++) {
    const jitter = hash(o.seed + i * 3.1)
    const ang = (i / o.count) * TAU + (jitter - 0.5) * 0.5 - Math.PI / 2
    const dist = o.r0 + o.spread * travel * (0.75 + 0.5 * hash(o.seed + i * 7.7))
    const color = o.colors[i % o.colors.length] ?? '#ffffff'
    const size = o.size * (0.6 + 0.6 * hash(o.seed + i * 1.3)) * (1 - 0.6 * p)
    const x = Math.cos(ang) * dist
    const y = Math.sin(ang) * dist
    ctx.save()
    mulAlpha(ctx, fade)
    if (o.streaks) {
      const len = size * 2.6 * (1 - p * 0.5)
      ctx.beginPath()
      ctx.moveTo(x - Math.cos(ang) * len, y - Math.sin(ang) * len)
      ctx.lineTo(x, y)
      ctx.strokeStyle = color
      ctx.lineWidth = size * 0.7
      ctx.lineCap = 'round'
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.arc(x, y, Math.max(size / 2, 0.01), 0, TAU)
      ctx.fillStyle = color
      ctx.fill()
    }
    ctx.restore()
  }
}

/** Expanding stroked ring; `p` 0→1. */
export function drawRipple(
  ctx: CanvasRenderingContext2D,
  p: number,
  r0: number,
  r1: number,
  color: string,
  width: number,
): void {
  if (p <= 0 || p >= 1) return
  const e = ease.outCubic(p)
  ctx.save()
  mulAlpha(ctx, 1 - p)
  ctx.beginPath()
  ctx.arc(0, 0, Math.max(lerp(r0, r1, e), 0.01), 0, TAU)
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(width * (1 - 0.7 * p), 0.01)
  ctx.stroke()
  ctx.restore()
}
