/**
 * Spotlight drawing: the frame blurred + dimmed, with the highlighted area
 * drawn sharp on top through a feathered mask.
 *
 * The sharp part is rendered on ONE reused scratch canvas, sized to the
 * highlighted area only (plus the feather margin), and masked with
 * `destination-in` — no per-frame allocation of big canvases.
 */
import type { SourceRect, SpotlightSample } from './sample'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

let scratch: HTMLCanvasElement | OffscreenCanvas | null = null
let scratchCtx: Ctx2D | null = null

/** Largest scratch side (device px). */
const MAX_SCRATCH = 4096

function getScratch(w: number, h: number): Ctx2D | null {
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : typeof document !== 'undefined'
          ? document.createElement('canvas')
          : null
    scratchCtx = scratch?.getContext('2d') ?? null
  }
  if (!scratch || !scratchCtx) return null
  // Grow only (rounded up), so a moving / animating rect doesn't reallocate
  // the backing store every frame.
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.min(
      MAX_SCRATCH,
      Math.max(scratch.width, Math.ceil(w / 64) * 64),
    )
    scratch.height = Math.min(
      MAX_SCRATCH,
      Math.max(scratch.height, Math.ceil(h / 64) * 64),
    )
  }
  return scratchCtx
}

function shapePath(
  ctx: Ctx2D,
  shape: SpotlightSample['shape'],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.beginPath()
  if (shape === 'ellipse')
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  else ctx.rect(x, y, w, h)
}

function joinFilter(a: string | null, b: string | null): string {
  const parts = [a, b].filter((p): p is string => !!p)
  return parts.length ? parts.join(' ') : 'none'
}

/**
 * Draw `el` cropped to `crop` into the box (`w`×`h`, centred on the current
 * origin — the caller has already translated/rotated and set globalAlpha),
 * with spotlight `sp`. The spotlight rect is in fractions of `region` (the
 * picture's kept part after a user crop; the whole source otherwise).
 * `baseFilter` is the clip's colour filter; `pxScale` converts project px to
 * output px for filter lengths.
 */
export function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  el: CanvasImageSource,
  crop: SourceRect,
  region: SourceRect,
  w: number,
  h: number,
  sp: SpotlightSample,
  baseFilter: string | null,
  pxScale: number,
): void {
  const { sx, sy, sw, sh } = crop
  const alpha = ctx.globalAlpha

  // 1. Background: blurred, then dimmed. Clipped to the box so the blur
  //    doesn't bleed over neighbouring layers.
  ctx.save()
  ctx.beginPath()
  ctx.rect(-w / 2, -h / 2, w, h)
  ctx.clip()
  ctx.filter = joinFilter(
    baseFilter,
    sp.blur > 0 ? `blur(${sp.blur * pxScale}px)` : null,
  )
  ctx.drawImage(el, sx, sy, sw, sh, -w / 2, -h / 2, w, h)
  ctx.filter = 'none'
  if (sp.dim > 0) {
    ctx.globalAlpha = alpha * sp.dim
    ctx.fillStyle = '#000'
    ctx.fillRect(-w / 2, -h / 2, w, h)
  }
  ctx.restore()

  // 2. Highlighted area, mapped through the same crop into box coordinates.
  const toBoxX = (u: number) => ((region.sx + u * region.sw - sx) / sw) * w - w / 2
  const toBoxY = (v: number) => ((region.sy + v * region.sh - sy) / sh) * h - h / 2
  const rx = toBoxX(sp.x)
  const ry = toBoxY(sp.y)
  const rw = toBoxX(sp.x + sp.w) - rx
  const rh = toBoxY(sp.y + sp.h) - ry
  if (rw <= 0 || rh <= 0) return
  const feather = sp.feather * 0.5 * Math.min(rw, rh)
  const margin = feather * 1.5
  const ex0 = Math.max(-w / 2, rx - margin)
  const ey0 = Math.max(-h / 2, ry - margin)
  const ex1 = Math.min(w / 2, rx + rw + margin)
  const ey1 = Math.min(h / 2, ry + rh + margin)
  if (ex1 - ex0 < 0.5 || ey1 - ey0 < 0.5) return

  let k = Math.max(0.01, pxScale)
  const longest = Math.max(ex1 - ex0, ey1 - ey0) * k
  if (longest > MAX_SCRATCH) k *= MAX_SCRATCH / longest
  const cw = Math.max(1, Math.ceil((ex1 - ex0) * k))
  const ch = Math.max(1, Math.ceil((ey1 - ey0) * k))
  const s = getScratch(cw, ch)
  if (!s) return

  s.save()
  s.setTransform(1, 0, 0, 1, 0, 0)
  s.globalCompositeOperation = 'source-over'
  s.globalAlpha = 1
  s.filter = 'none'
  s.clearRect(0, 0, cw + 1, ch + 1)
  s.beginPath()
  s.rect(0, 0, cw, ch)
  s.clip()
  s.setTransform(k, 0, 0, k, -ex0 * k, -ey0 * k)
  s.filter = joinFilter(baseFilter, null)
  s.drawImage(el, sx, sy, sw, sh, -w / 2, -h / 2, w, h)
  s.globalCompositeOperation = 'destination-in'
  s.filter = feather > 0 ? `blur(${(feather / 2) * k}px)` : 'none'
  s.fillStyle = '#000'
  shapePath(s, sp.shape, rx, ry, rw, rh)
  s.fill()
  s.restore()

  ctx.save()
  ctx.filter = 'none'
  ctx.globalAlpha = alpha
  ctx.drawImage(s.canvas as CanvasImageSource, 0, 0, cw, ch, ex0, ey0, cw / k, ch / k)
  ctx.restore()
}
