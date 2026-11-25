import { DEFAULT_TEXT_FONT } from './fonts'
import { TEXT_STYLE_KEYS, type RichTextStyle, type TextStyleFields } from './style'

/**
 * Text styles: named sets of text formatting (everything but the content).
 * Built-ins ship with the app; user styles are kept in localStorage (they
 * are a per-user convenience, not project data). Storage failures (private
 * mode, quota, blocked) are ignored: saving then just doesn't persist.
 */

export interface TextPreset {
  id: string
  name: string
  builtIn: boolean
  style: Partial<TextStyleFields>
}

export const PRESETS_STORAGE_KEY = 'ir.textPresets.v1'

const MONTSERRAT = '"Montserrat Variable", Montserrat, system-ui, sans-serif'
const POPPINS = 'Poppins, system-ui, sans-serif'

export const BUILT_IN_PRESETS: readonly TextPreset[] = [
  {
    id: 'builtin:title',
    name: 'Title',
    builtIn: true,
    style: {
      fontFamily: MONTSERRAT,
      fontSize: 110,
      fontWeight: 800,
      color: '#ffffff',
      align: 'center',
      letterSpacing: -0.02,
      lineHeight: 1.05,
      strokeWidth: 0,
      shadow: true,
      shadowColor: 'rgba(0,0,0,0.45)',
      shadowBlur: 18,
      shadowOffsetX: 0,
      shadowOffsetY: 6,
    },
  },
  {
    id: 'builtin:subtitle',
    name: 'Subtitle',
    builtIn: true,
    style: {
      fontFamily: DEFAULT_TEXT_FONT,
      fontSize: 52,
      fontWeight: 500,
      color: '#e8e6f5',
      align: 'center',
      letterSpacing: 0.12,
      lineHeight: 1.3,
      strokeWidth: 0,
      shadow: true,
      shadowColor: 'rgba(0,0,0,0.5)',
      shadowBlur: 10,
      shadowOffsetX: 0,
      shadowOffsetY: 3,
    },
  },
  {
    id: 'builtin:lower-third',
    name: 'Lower third',
    builtIn: true,
    style: {
      fontFamily: POPPINS,
      fontSize: 44,
      fontWeight: 600,
      color: '#ffffff',
      align: 'left',
      lineHeight: 1.25,
      strokeWidth: 0,
      shadow: false,
      background: '#7c3aed',
      backgroundOpacity: 0.92,
      backgroundPadding: 0.6,
      backgroundRadius: 10,
    },
  },
  {
    id: 'builtin:caption',
    name: 'Caption style',
    builtIn: true,
    style: {
      fontFamily: DEFAULT_TEXT_FONT,
      fontSize: 46,
      fontWeight: 600,
      color: '#ffffff',
      align: 'center',
      lineHeight: 1.25,
      boxWidth: 1400,
      strokeWidth: 0,
      shadow: false,
      background: '#000000',
      backgroundOpacity: 0.6,
      backgroundPadding: 0.45,
      backgroundRadius: 12,
    },
  },
]

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const KEY_TYPES: Record<
  (typeof TEXT_STYLE_KEYS)[number],
  'string' | 'number' | 'boolean'
> = {
  fontFamily: 'string',
  fontSize: 'number',
  fontWeight: 'number',
  color: 'string',
  background: 'string',
  align: 'string',
  strokeColor: 'string',
  strokeWidth: 'number',
  shadow: 'boolean',
  italic: 'boolean',
  underline: 'boolean',
  letterSpacing: 'number',
  lineHeight: 'number',
  boxWidth: 'number',
  backgroundOpacity: 'number',
  backgroundPadding: 'number',
  backgroundRadius: 'number',
  shadowColor: 'string',
  shadowBlur: 'number',
  shadowOffsetX: 'number',
  shadowOffsetY: 'number',
}

/** Keep only known style keys with plausible value types. */
function sanitizeStyle(raw: unknown): Partial<TextStyleFields> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const key of TEXT_STYLE_KEYS) {
    const v = raw[key]
    const type = KEY_TYPES[key]
    if (
      type === 'number'
        ? typeof v === 'number' && Number.isFinite(v)
        : typeof v === type
    )
      out[key] = v
  }
  if (
    out.align !== undefined &&
    !['left', 'center', 'right'].includes(out.align as string)
  )
    delete out.align
  return out as Partial<TextStyleFields>
}

/** The style part of a text style (content dropped, absent keys omitted). */
export function styleOf(text: RichTextStyle): Partial<TextStyleFields> {
  return sanitizeStyle(text)
}

/** User-saved presets (newest last). Corrupt storage reads as empty. */
export function loadUserPresets(): TextPreset[] {
  const ls = storage()
  if (!ls) return []
  try {
    const raw: unknown = JSON.parse(ls.getItem(PRESETS_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.flatMap((p): TextPreset[] => {
      if (!isRecord(p) || typeof p.id !== 'string' || typeof p.name !== 'string')
        return []
      return [{ id: p.id, name: p.name, builtIn: false, style: sanitizeStyle(p.style) }]
    })
  } catch {
    return []
  }
}

function writeUserPresets(presets: readonly TextPreset[]): boolean {
  const ls = storage()
  if (!ls) return false
  try {
    ls.setItem(
      PRESETS_STORAGE_KEY,
      JSON.stringify(presets.map((p) => ({ id: p.id, name: p.name, style: p.style }))),
    )
    return true
  } catch {
    return false
  }
}

/** Built-ins followed by the user's presets. */
export function listPresets(): TextPreset[] {
  return [...BUILT_IN_PRESETS, ...loadUserPresets()]
}

/**
 * Save `text`'s style (minus content) under `name`. A user preset with the
 * same name (case-insensitive) is replaced. Returns the preset, which is
 * usable for this session even if it couldn't be persisted.
 */
export function savePreset(name: string, text: RichTextStyle): TextPreset {
  const trimmed = name.trim().slice(0, 60) || 'My style'
  const presets = loadUserPresets()
  const existing = presets.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
  const preset: TextPreset = {
    id:
      existing?.id ??
      `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    builtIn: false,
    style: styleOf(text),
  }
  writeUserPresets(
    existing
      ? presets.map((p) => (p.id === existing.id ? preset : p))
      : [...presets, preset],
  )
  return preset
}

/** Delete a user preset (built-ins can't be deleted). */
export function deletePreset(id: string): boolean {
  const presets = loadUserPresets()
  const next = presets.filter((p) => p.id !== id)
  if (next.length === presets.length) return false
  return writeUserPresets(next)
}

/**
 * The patch that applies `preset` to a text: every style key is present —
 * keys the preset doesn't set as `undefined` — so formatting the target had
 * and the preset doesn't is cleared. Required `TextStyle` keys the preset
 * omits are left out (the target keeps its value).
 */
export function presetPatch(preset: TextPreset): Partial<RichTextStyle> {
  const REQUIRED = new Set<string>([
    'fontFamily',
    'fontSize',
    'fontWeight',
    'color',
    'align',
  ])
  const patch: Record<string, unknown> = {}
  for (const key of TEXT_STYLE_KEYS) {
    const v = preset.style[key]
    if (v !== undefined) patch[key] = v
    else if (!REQUIRED.has(key)) patch[key] = undefined
  }
  return patch as Partial<RichTextStyle>
}
