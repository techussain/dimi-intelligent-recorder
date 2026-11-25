/**
 * UI state: which effect is selected (inspector card, preview handles,
 * timeline bar). Kept out of the project so selecting is never an undo step.
 */
import { create } from 'zustand'
import type { ID } from '../timeline/types'

export interface SelectedEffect {
  clipId: ID
  effectId: ID
}

interface SelectedEffectState {
  selected: SelectedEffect | null
  select(sel: SelectedEffect | null): void
}

export const useSelectedEffect = create<SelectedEffectState>()((set) => ({
  selected: null,
  select(sel) {
    set({ selected: sel })
  },
}))

export function isEffectSelected(
  sel: SelectedEffect | null,
  clipId: ID,
  effectId: ID,
): boolean {
  return !!sel && sel.clipId === clipId && sel.effectId === effectId
}

/**
 * Chroma-key eyedropper: while set, the next click on the preview samples
 * that clip's current (unkeyed) frame into the effect's key colour.
 */
interface KeyPickerState {
  picking: SelectedEffect | null
  start(sel: SelectedEffect): void
  cancel(): void
}

export const useKeyPicker = create<KeyPickerState>()((set) => ({
  picking: null,
  start(sel) {
    set({ picking: sel })
  },
  cancel() {
    set({ picking: null })
  },
}))

/**
 * True while the user is pressing/dragging on the preview to aim the selected
 * zoom or spotlight. Only then is the clip drawn without its camera effects
 * (with the aiming outline); otherwise the preview shows the real result.
 */
interface EffectAimState {
  aiming: boolean
  setAiming(aiming: boolean): void
}

export const useEffectAim = create<EffectAimState>()((set) => ({
  aiming: false,
  setAiming(aiming) {
    set({ aiming })
  },
}))
