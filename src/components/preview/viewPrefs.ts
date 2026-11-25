import { create } from 'zustand'

/** Preview-only guides (never exported). */
export interface ViewPrefs {
  rulers: boolean
  safe: boolean
  thirds: boolean
  center: boolean
}

const STORAGE_KEY = 'ir.preview.view'
const DEFAULT_PREFS: ViewPrefs = {
  rulers: false,
  safe: false,
  thirds: false,
  center: false,
}

function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    const v = JSON.parse(raw) as Partial<Record<keyof ViewPrefs, unknown>>
    return {
      rulers: v.rulers === true,
      safe: v.safe === true,
      thirds: v.thirds === true,
      center: v.center === true,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export const useViewPrefs = create<
  ViewPrefs & { toggle: (key: keyof ViewPrefs) => void }
>((set, get) => ({
  ...loadPrefs(),
  toggle: (key) => {
    set({ [key]: !get()[key] })
    const { rulers, safe, thirds, center } = get()
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ rulers, safe, thirds, center }),
      )
    } catch {
      /* storage unavailable — the toggle just isn't remembered */
    }
  },
}))
