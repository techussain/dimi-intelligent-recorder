import { clamp } from './anim'
import { resolveParams } from './params'
import { getTemplate } from './templates'
import type { ElementBox, ElementParams } from './types'

const reported = new Set<string>()

/**
 * Draw one frame of an element. The context origin must be the CENTER of the
 * element's box (the compositor applies position, rotation and opacity).
 *
 * Never throws: an unknown template, a bad box or an error inside a template
 * draws nothing (the error is logged once per template + message) so the
 * render loop keeps running. Returns whether anything was drawn.
 */
export function drawElement(
  ctx: CanvasRenderingContext2D,
  templateId: string,
  params: ElementParams | null | undefined,
  t: number,
  duration: number,
  box: ElementBox,
): boolean {
  const template = getTemplate(templateId)
  if (!template) return false
  if (!(box.w > 0 && box.h > 0) || !Number.isFinite(box.w + box.h)) return false
  const d =
    Number.isFinite(duration) && duration > 0 ? duration : template.defaultDuration
  if (!Number.isFinite(t) || t < 0 || t > d) return false
  const tt = clamp(t, 0, d)

  // Count the template's own save()s so a throw mid-draw can unwind exactly
  // the states it pushed (never the caller's).
  const nativeSave = ctx.save
  const nativeRestore = ctx.restore
  const ownSave = Object.prototype.hasOwnProperty.call(ctx, 'save')
  const ownRestore = Object.prototype.hasOwnProperty.call(ctx, 'restore')
  let depth = 0
  let ok = false
  try {
    const resolved = resolveParams(template, params)
    ctx.save = () => {
      depth++
      nativeSave.call(ctx)
    }
    ctx.restore = () => {
      if (depth > 0) depth--
      nativeRestore.call(ctx)
    }
    ctx.save()
    template.draw(ctx, resolved, tt, d, box)
    ok = true
  } catch (err) {
    const key = `${templateId}:${err instanceof Error ? err.message : String(err)}`
    if (!reported.has(key)) {
      reported.add(key)
      console.error(`[elements] "${templateId}" failed to draw`, err)
    }
  } finally {
    try {
      // Drop the instance overrides so the prototype methods show through.
      if (ownSave) ctx.save = nativeSave
      else delete (ctx as Partial<CanvasRenderingContext2D>).save
      if (ownRestore) ctx.restore = nativeRestore
      else delete (ctx as Partial<CanvasRenderingContext2D>).restore
      for (; depth > 0; depth--) nativeRestore.call(ctx)
    } catch {
      // Context unusable — nothing more we can do.
    }
  }
  return ok
}
