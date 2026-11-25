import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILT_IN_PRESETS,
  deletePreset,
  listPresets,
  loadUserPresets,
  PRESETS_STORAGE_KEY,
  presetPatch,
  savePreset,
} from '../presets'
import { TEXT_STYLE_KEYS, type RichTextStyle } from '../style'
import { FONT_OPTIONS, fontOptionFor } from '../fonts'

class MemoryStorage implements Storage {
  map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
}

const text: RichTextStyle = {
  content: 'Secret content',
  fontFamily: 'Poppins, system-ui, sans-serif',
  fontSize: 40,
  fontWeight: 600,
  color: '#ff0000',
  align: 'left',
  italic: true,
  letterSpacing: 0.05,
  background: '#000000',
  backgroundRadius: 8,
}

let store: MemoryStorage

beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('text presets', () => {
  it('lists the four built-ins first', () => {
    expect(listPresets().map((p) => p.name)).toEqual([
      'Title',
      'Subtitle',
      'Lower third',
      'Caption style',
    ])
    expect(BUILT_IN_PRESETS.every((p) => p.builtIn)).toBe(true)
  })

  it('built-ins use bundled fonts', () => {
    for (const p of BUILT_IN_PRESETS) {
      expect(fontOptionFor(p.style.fontFamily ?? '')).toBeDefined()
    }
  })

  it('saves the style without the content and loads it back', () => {
    const saved = savePreset('  Red label ', text)
    expect(saved.name).toBe('Red label')
    expect(saved.style).not.toHaveProperty('content')
    expect(saved.style).toMatchObject({
      fontSize: 40,
      italic: true,
      backgroundRadius: 8,
    })
    const loaded = loadUserPresets()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(saved)
    expect(listPresets()).toHaveLength(BUILT_IN_PRESETS.length + 1)
    expect(store.getItem(PRESETS_STORAGE_KEY)).not.toContain('Secret content')
  })

  it('replaces a preset with the same name', () => {
    const a = savePreset('Mine', text)
    const b = savePreset('mine', { ...text, fontSize: 90 })
    expect(b.id).toBe(a.id)
    const loaded = loadUserPresets()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.style.fontSize).toBe(90)
  })

  it('deletes user presets only', () => {
    const a = savePreset('A', text)
    savePreset('B', text)
    expect(deletePreset(a.id)).toBe(true)
    expect(loadUserPresets().map((p) => p.name)).toEqual(['B'])
    expect(deletePreset('builtin:title')).toBe(false)
    expect(listPresets()[0]?.id).toBe('builtin:title')
  })

  it('reads corrupt or foreign storage as empty / sanitized', () => {
    store.setItem(PRESETS_STORAGE_KEY, '{not json')
    expect(loadUserPresets()).toEqual([])
    store.setItem(
      PRESETS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'x',
          name: 'X',
          style: { fontSize: 'big', color: '#fff', align: 'up', evil: 1 },
        },
        { nope: true },
      ]),
    )
    expect(loadUserPresets()).toEqual([
      { id: 'x', name: 'X', builtIn: false, style: { color: '#fff' } },
    ])
  })

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(loadUserPresets()).toEqual([])
    const p = savePreset('X', text)
    expect(p.name).toBe('X')
    expect(deletePreset(p.id)).toBe(false)
  })

  it('preset patches set every style key and clear what the preset lacks', () => {
    const title = BUILT_IN_PRESETS[0]
    if (!title) throw new Error('no built-ins')
    const patch = presetPatch(title)
    expect(patch).not.toHaveProperty('content')
    for (const key of TEXT_STYLE_KEYS) expect(key in patch).toBe(true)
    // Title has no background: applying it removes one.
    expect(patch.background).toBeUndefined()
    expect(patch.fontWeight).toBe(800)
    // Required keys missing from a preset are left alone, not cleared.
    const partial = presetPatch({
      id: 'p',
      name: 'p',
      builtIn: false,
      style: { italic: true },
    })
    expect('fontSize' in partial).toBe(false)
    expect(partial.italic).toBe(true)
  })
})

describe('FONT_OPTIONS', () => {
  it('has unique ids, quoted multi-word families and sorted weights', () => {
    const ids = FONT_OPTIONS.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const o of FONT_OPTIONS) {
      expect(o.weights.length).toBeGreaterThan(0)
      expect([...o.weights].sort((a, b) => a - b)).toEqual(o.weights)
      expect(o.family).toMatch(/(sans-serif|serif|monospace)$/)
      expect(fontOptionFor(o.family)).toBe(o)
    }
  })
})
