/**
 * Elements are small procedural, vector-drawn animated overlays (subscribe
 * button, lower third, countdown…). They are drawn directly into the
 * compositor's 2D context every frame, so they stay sharp at any export size
 * and their text and colors stay editable.
 */

export type ElementCategory = 'social' | 'callout' | 'title' | 'timer'

/** Editable parameter values, keyed by `ElementParamDef.key`. */
export type ElementParams = Record<string, string | number>

interface ParamDefBase {
  /** Key into `ElementParams`. */
  key: string
  /** Human-readable label for the Inspector. */
  label: string
}

export interface TextParamDef extends ParamDefBase {
  kind: 'text'
  maxLength?: number
  /**
   * When present the value must be one of these (render as a select).
   * Labels default to the option value itself.
   */
  options?: readonly { value: string; label: string }[]
}

export interface ColorParamDef extends ParamDefBase {
  /** Value is a `#rrggbb` hex string. */
  kind: 'color'
}

export interface NumberParamDef extends ParamDefBase {
  kind: 'number'
  min: number
  max: number
  step?: number
}

export type ElementParamDef = TextParamDef | ColorParamDef | NumberParamDef

/** The element's box size in the context's current units. */
export interface ElementBox {
  w: number
  h: number
}

export interface ElementTemplate {
  id: string
  name: string
  category: ElementCategory
  /** Default clip length in seconds. */
  defaultDuration: number
  /** Intrinsic size in px at 1080p — the default box of a new element. */
  size: { w: number; h: number }
  params: readonly ElementParamDef[]
  defaults: ElementParams
  /**
   * Draw one frame. The context origin is the CENTER of the box (the caller
   * applies position/rotation/opacity); everything scales with `box`.
   * Must be deterministic in `t` (seconds since clip start) and must
   * multiply — never overwrite — `ctx.globalAlpha`.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    params: ElementParams,
    t: number,
    duration: number,
    box: ElementBox,
  ): void
}
