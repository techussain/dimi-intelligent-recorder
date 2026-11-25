/**
 * Bundled text fonts (all OFL-1.1, Roboto Slab Apache-2.0), served from the
 * app bundle: Vite emits the woff2 files next to the CSS, so they load under
 * the `font-src 'self'` CSP and work offline. Each family's CSS registers
 * every subset with a unicode-range, so the browser fetches only the subsets
 * a text actually uses.
 */
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/inter/wght-italic.css'
import '@fontsource-variable/montserrat'
import '@fontsource-variable/montserrat/wght-italic.css'
import '@fontsource/poppins/400.css'
import '@fontsource/poppins/400-italic.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/600-italic.css'
import '@fontsource/poppins/700.css'
import '@fontsource/poppins/700-italic.css'
import '@fontsource/poppins/800.css'
import '@fontsource/poppins/800-italic.css'
import '@fontsource-variable/roboto-slab'
import '@fontsource-variable/playfair-display'
import '@fontsource-variable/playfair-display/wght-italic.css'
import '@fontsource/bebas-neue'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/jetbrains-mono/wght-italic.css'

export type FontCategory = 'sans' | 'serif' | 'display' | 'mono'

export interface FontOption {
  id: string
  label: string
  /** CSS font-family stack (bundled family first, then fallbacks). */
  family: string
  category: FontCategory
  /** Weights offered in the picker (the face supports at least these). */
  weights: readonly number[]
  /** A real italic face is bundled (otherwise the browser slants it). */
  italic: boolean
  /** Lower-case family names that should map to this option (legacy values). */
  aliases: readonly string[]
}

/** Default family for new text (the bundled Inter; plain `Inter` isn't registered). */
export const DEFAULT_TEXT_FONT = '"Inter Variable", Inter, system-ui, sans-serif'

const VAR_WEIGHTS = [300, 400, 500, 600, 700, 800, 900] as const

export const FONT_OPTIONS: readonly FontOption[] = [
  {
    id: 'inter',
    label: 'Inter',
    family: DEFAULT_TEXT_FONT,
    category: 'sans',
    weights: VAR_WEIGHTS,
    italic: true,
    aliases: ['inter variable', 'inter'],
  },
  {
    id: 'montserrat',
    label: 'Montserrat',
    family: '"Montserrat Variable", Montserrat, system-ui, sans-serif',
    category: 'sans',
    weights: VAR_WEIGHTS,
    italic: true,
    aliases: ['montserrat variable', 'montserrat'],
  },
  {
    id: 'poppins',
    label: 'Poppins',
    family: 'Poppins, system-ui, sans-serif',
    category: 'sans',
    weights: [400, 600, 700, 800],
    italic: true,
    aliases: ['poppins'],
  },
  {
    id: 'roboto-slab',
    label: 'Roboto Slab',
    family: '"Roboto Slab Variable", "Roboto Slab", Georgia, serif',
    category: 'serif',
    weights: VAR_WEIGHTS,
    italic: false,
    aliases: ['roboto slab variable', 'roboto slab'],
  },
  {
    id: 'playfair-display',
    label: 'Playfair Display',
    family: '"Playfair Display Variable", "Playfair Display", Georgia, serif',
    category: 'serif',
    weights: [400, 500, 600, 700, 800, 900],
    italic: true,
    aliases: ['playfair display variable', 'playfair display'],
  },
  {
    id: 'bebas-neue',
    label: 'Bebas Neue',
    family: '"Bebas Neue", Impact, sans-serif',
    category: 'display',
    weights: [400],
    italic: false,
    aliases: ['bebas neue'],
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    family: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
    category: 'mono',
    weights: [300, 400, 500, 600, 700, 800],
    italic: true,
    aliases: ['jetbrains mono variable', 'jetbrains mono'],
  },
]

/** First family of a CSS font-family stack, unquoted and lower-cased. */
function primaryFamily(stack: string): string {
  const first = stack.split(',')[0] ?? ''
  return first
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
    .toLowerCase()
}

/** The bundled option a font-family stack refers to (by its first family). */
export function fontOptionFor(family: string): FontOption | undefined {
  const primary = primaryFamily(family)
  return FONT_OPTIONS.find((o) => o.aliases.includes(primary))
}

/**
 * Map a stored family onto the registered bundled family: e.g. the legacy
 * default `Inter, system-ui, sans-serif` (which isn't registered, the bundle
 * registers "Inter Variable") becomes `DEFAULT_TEXT_FONT`. Unknown families
 * are returned unchanged.
 */
export function normalizeFontFamily(family: string): string {
  const option = fontOptionFor(family)
  if (!option || family === option.family) return family || DEFAULT_TEXT_FONT
  return option.family
}

/** The supported weight of `option` closest to `weight` (ties → heavier). */
export function nearestWeight(option: FontOption, weight: number): number {
  let best = option.weights[0] ?? 400
  for (const w of option.weights) {
    if (Math.abs(w - weight) <= Math.abs(best - weight)) best = w
  }
  return best
}

/**
 * Load one face so the first rendered frame doesn't fall back to a system
 * font. Resolves to false when it couldn't be loaded (the fallback is used).
 */
export async function ensureFontLoaded(
  family: string,
  weight = 400,
  italic = false,
  sample = 'AaBbGg 0123',
): Promise<boolean> {
  if (typeof document === 'undefined' || !('fonts' in document)) return false
  try {
    const faces = await document.fonts.load(
      `${italic ? 'italic ' : ''}${String(weight)} 48px ${normalizeFontFamily(family)}`,
      sample,
    )
    return faces.length > 0
  } catch {
    return false
  }
}
