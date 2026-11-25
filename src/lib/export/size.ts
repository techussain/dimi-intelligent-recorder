/**
 * Output size for an export preset that keeps the project's aspect ratio.
 * The preset's short side is matched (so "1080p" means a 1080px short side
 * for landscape, portrait and square projects alike); the long side follows
 * the project aspect. Both dimensions are rounded to even numbers, which
 * H.264/VP9 encoders require.
 */
export function fitExportSize(
  projectW: number,
  projectH: number,
  presetW: number,
  presetH: number,
): { width: number; height: number } {
  const pw = Math.max(1, projectW)
  const ph = Math.max(1, projectH)
  const scale = Math.min(presetW, presetH) / Math.min(pw, ph)
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { width: even(pw * scale), height: even(ph * scale) }
}
