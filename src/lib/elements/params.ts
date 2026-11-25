import { clamp, isHexColor } from './anim'
import type { ElementParams, ElementTemplate } from './types'

/** Read a string param (numbers are stringified), else `fallback`. */
export function str(p: ElementParams, key: string, fallback: string): string {
  const v = p[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fallback
}

/** Read a finite number param (numeric strings accepted), else `fallback`. */
export function num(p: ElementParams, key: string, fallback: number): number {
  const v = p[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

/** Read a `#rgb` / `#rrggbb` color param, else `fallback`. */
export function color(p: ElementParams, key: string, fallback: string): string {
  const v = p[key]
  return isHexColor(v) ? v.trim() : fallback
}

/**
 * Merge `params` over the template defaults and coerce every declared param
 * to a valid value (numbers clamped, colors validated, options enforced,
 * text truncated). Unknown keys are dropped.
 */
export function resolveParams(
  template: ElementTemplate,
  params: ElementParams | null | undefined,
): ElementParams {
  const src = params ?? {}
  const out: ElementParams = {}
  for (const def of template.params) {
    const dflt = template.defaults[def.key]
    switch (def.kind) {
      case 'text': {
        const fb = typeof dflt === 'string' ? dflt : ''
        let v = str(src, def.key, fb)
        if (def.options && !def.options.some((o) => o.value === v)) v = fb
        if (def.maxLength !== undefined) v = v.slice(0, def.maxLength)
        out[def.key] = v
        break
      }
      case 'color': {
        const fb = isHexColor(dflt) ? dflt : '#7C3AED'
        out[def.key] = color(src, def.key, fb)
        break
      }
      case 'number': {
        const fb = typeof dflt === 'number' ? dflt : def.min
        out[def.key] = clamp(num(src, def.key, fb), def.min, def.max)
        break
      }
    }
  }
  return out
}
