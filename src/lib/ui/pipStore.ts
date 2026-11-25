import { create } from 'zustand'
import type { CaptureOptions } from '../capture/captureManager'

/**
 * Floating webcam self-view PIP UI state. Pure UI — not part of the project /
 * undo history. Persisted to localStorage so the user's last position, size,
 * and toggle survive reloads.
 */
export interface PipRect {
  x: number
  y: number
  width: number
  height: number
}

interface PipState {
  selfViewEnabled: boolean
  rect: PipRect
  mirrored: boolean
  /** Live webcam MediaStream currently held by WebcamPip (null when inactive). Not persisted. */
  webcamStream: MediaStream | null
  /**
   * True while the recorder is recording from `webcamStream`. The preview
   * must keep that stream open until the take stops, even if the user hides
   * the self-view — stopping it would end the webcam recording. Not persisted.
   */
  webcamBorrowed: boolean
  setSelfView: (v: boolean) => void
  toggleSelfView: () => void
  setRect: (r: PipRect) => void
  setMirrored: (v: boolean) => void
  setWebcamStream: (s: MediaStream | null) => void
  setWebcamBorrowed: (v: boolean) => void
}

const PIP_KEY = 'ir-pip-state'
const DEFAULT_W = 320
const DEFAULT_H = 180 // 16:9

function defaultRect(): PipRect {
  if (typeof window === 'undefined') {
    return { x: 24, y: 24, width: DEFAULT_W, height: DEFAULT_H }
  }
  const x = Math.max(8, Math.floor((window.innerWidth - DEFAULT_W) / 2))
  const y = Math.max(8, window.innerHeight - DEFAULT_H - 24)
  return { x, y, width: DEFAULT_W, height: DEFAULT_H }
}

function loadPip(): { selfViewEnabled: boolean; rect: PipRect; mirrored: boolean } {
  const fallback = {
    selfViewEnabled: false,
    rect: defaultRect(),
    mirrored: true,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(PIP_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<typeof fallback>
    return {
      selfViewEnabled: !!parsed.selfViewEnabled,
      rect:
        parsed.rect && typeof parsed.rect.width === 'number'
          ? clampRect(parsed.rect)
          : defaultRect(),
      mirrored: parsed.mirrored ?? true,
    }
  } catch {
    return fallback
  }
}

function persistPip(s: { selfViewEnabled: boolean; rect: PipRect; mirrored: boolean }) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      PIP_KEY,
      JSON.stringify({
        selfViewEnabled: s.selfViewEnabled,
        rect: s.rect,
        mirrored: s.mirrored,
      }),
    )
  } catch {
    // ignore quota / private mode errors
  }
}

/** Clamp a rect inside the current viewport, preserving 16:9. */
export function clampRect(r: PipRect): PipRect {
  if (typeof window === 'undefined') return r
  const vw = window.innerWidth
  const vh = window.innerHeight
  const minW = 160
  const minH = 90
  const maxW = Math.max(minW, Math.floor(vw * 0.5))
  let width = Math.min(Math.max(r.width, minW), maxW)
  let height = Math.round((width * 9) / 16)
  if (height < minH) {
    height = minH
    width = Math.round((height * 16) / 9)
  }
  if (height > vh - 16) {
    height = Math.max(minH, vh - 16)
    width = Math.round((height * 16) / 9)
  }
  const x = Math.min(Math.max(8, r.x), Math.max(8, vw - width - 8))
  const y = Math.min(Math.max(8, r.y), Math.max(8, vh - height - 8))
  return { x, y, width, height }
}

export const usePipStore = create<PipState>((set, get) => {
  const initial = loadPip()
  return {
    ...initial,
    webcamStream: null,
    webcamBorrowed: false,
    setSelfView: (v) => {
      set({ selfViewEnabled: v })
      persistPip(get())
    },
    toggleSelfView: () => {
      set({ selfViewEnabled: !get().selfViewEnabled })
      persistPip(get())
    },
    setRect: (r) => {
      set({ rect: clampRect(r) })
      persistPip(get())
    },
    setMirrored: (v) => {
      set({ mirrored: v })
      persistPip(get())
    },
    setWebcamStream: (s) => {
      set({ webcamStream: s })
    },
    setWebcamBorrowed: (v) => {
      set({ webcamBorrowed: v })
    },
  }
})

/* ------------------------------------------------------------------ */
/* Capture options (UI-only state, hoisted from TopBar so the floating
   webcam PIP can read the selected webcam device + enabled flag).    */
/* ------------------------------------------------------------------ */

interface CaptureOptsState {
  opts: CaptureOptions
  setOpts: (updater: (o: CaptureOptions) => CaptureOptions) => void
  patchOpts: (patch: Partial<CaptureOptions>) => void
}

const OPTS_KEY = 'ir-capture-opts'

function loadOpts(): CaptureOptions {
  const fallback: CaptureOptions = {
    screen: true,
    systemAudio: true,
    mic: true,
    webcam: false,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(OPTS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<CaptureOptions>
    return {
      screen: parsed.screen ?? true,
      systemAudio: parsed.systemAudio ?? true,
      mic: parsed.mic ?? true,
      webcam: parsed.webcam ?? false,
      micDeviceId: parsed.micDeviceId,
      webcamDeviceId: parsed.webcamDeviceId,
      timesliceMs: parsed.timesliceMs,
    }
  } catch {
    return fallback
  }
}

function persistOpts(o: CaptureOptions) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(OPTS_KEY, JSON.stringify(o))
  } catch {
    // ignore
  }
}

export const useCaptureOpts = create<CaptureOptsState>((set, get) => ({
  opts: loadOpts(),
  setOpts: (updater) => {
    const next = updater(get().opts)
    set({ opts: next })
    persistOpts(next)
  },
  patchOpts: (patch) => {
    const next = { ...get().opts, ...patch }
    set({ opts: next })
    persistOpts(next)
  },
}))
