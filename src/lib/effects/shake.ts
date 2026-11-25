/**
 * Deterministic camera-shake noise. The same effect id and time always give
 * the same offset, so preview, scrubbing and export match frame for frame
 * (never Math.random).
 */

/** 32-bit FNV-1a hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Integer hash → [-1, 1]. */
function lattice(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i | 0, 0x27d4eb2d)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h = (h ^ (h >>> 16)) >>> 0
  return (h / 0xffffffff) * 2 - 1
}

/** Smooth 1-D value noise in [-1, 1] at position `x`. */
export function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  const a = lattice(seed, i)
  const b = lattice(seed, i + 1)
  return a + (b - a) * u
}

/**
 * Shake offset (unit amplitude) for effect `seedKey` at time `t` seconds and
 * `frequency` Hz. Two octaves keep it from looking like a plain wobble.
 */
export function shakeOffset(
  seedKey: string,
  t: number,
  frequency: number,
): { x: number; y: number } {
  const seed = hashString(seedKey)
  const sy = (seed ^ 0x9e3779b9) >>> 0
  const x = t * frequency
  const nx = valueNoise(seed, x) * 0.75 + valueNoise(seed + 7, x * 2.13) * 0.25
  const ny = valueNoise(sy, x) * 0.75 + valueNoise(sy + 7, x * 2.13) * 0.25
  return { x: nx, y: ny }
}
