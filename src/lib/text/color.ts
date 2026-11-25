/** Small CSS colour helpers for colour + opacity controls (hex / rgb[a] only). */

export interface HexAlpha {
  /** #rrggbb */
  hex: string
  /** 0..1 */
  alpha: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba(); else `fallback`. */
export function parseColor(css: string | undefined, fallback: HexAlpha): HexAlpha {
  if (!css) return fallback
  const s = css.trim().toLowerCase()
  let m = /^#([0-9a-f]{3,4})$/.exec(s)
  if (m) {
    const d = m[1] ?? ''
    const ch = (i: number) => parseInt((d[i] ?? 'f') + (d[i] ?? 'f'), 16)
    return {
      hex: `#${hex2(ch(0))}${hex2(ch(1))}${hex2(ch(2))}`,
      alpha: d.length === 4 ? ch(3) / 255 : 1,
    }
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s)
  if (m) {
    return { hex: `#${m[1] ?? '000000'}`, alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 }
  }
  m =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      s,
    )
  if (m) {
    const a = m[4]
    const alpha =
      a === undefined ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a)
    return {
      hex: `#${hex2(Number(m[1]))}${hex2(Number(m[2]))}${hex2(Number(m[3]))}`,
      alpha: clamp01(Number.isFinite(alpha) ? alpha : 1),
    }
  }
  return fallback
}

/** #rrggbb when opaque, else rgba(r,g,b,a). */
export function formatColor(hex: string, alpha: number): string {
  const a = clamp01(alpha)
  if (a >= 1) return hex
  const n = parseInt(hex.slice(1, 7), 16) || 0
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${String(r)},${String(g)},${String(b)},${String(Math.round(a * 1000) / 1000)})`
}
