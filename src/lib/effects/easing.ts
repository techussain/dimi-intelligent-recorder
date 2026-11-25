/**
 * Easing curves shared by keyframes (compositor/keyframes.ts, keyframe
 * splitting) and effects (zoom ramps), so every animated value in the app
 * eases the same way.
 */

export type EasingKind = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/** Map linear progress `x` (0..1) through an easing curve. */
export function ease(x: number, kind: EasingKind): number {
  switch (kind) {
    case 'ease-in':
      return x * x
    case 'ease-out':
      return 1 - (1 - x) * (1 - x)
    case 'ease-in-out':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
    default:
      return x
  }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1)
}

export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p
}
