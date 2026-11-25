/**
 * Minimal recording CanvasRenderingContext2D for jsdom (which has no canvas).
 * Every method call and property write is appended to `calls`; numeric
 * arguments are checked for NaN/Infinity by the tests.
 */

export type Call = [name: string, ...args: unknown[]]

interface State {
  globalAlpha: number
  transform: [number, number, number, number, number, number]
  font: string
  [key: string]: unknown
}

export interface MockContext {
  ctx: CanvasRenderingContext2D
  calls: Call[]
  /** Current save() depth (0 when balanced). */
  depth: () => number
}

function fontSize(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return m?.[1] ? Number(m[1]) : 10
}

function gradient(calls: Call[]): CanvasGradient {
  return {
    addColorStop: (offset: number, color: string) => {
      calls.push(['addColorStop', offset, color])
      if (offset < 0 || offset > 1) throw new RangeError('offset out of range')
    },
  }
}

export function createMockContext(): MockContext {
  const calls: Call[] = []
  let state: State = {
    globalAlpha: 1,
    transform: [1, 0, 0, 1, 0, 0],
    font: '10px sans-serif',
  }
  const stack: State[] = []

  const mul = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const [A, B, C, D, E, F] = state.transform
    state.transform = [
      A * a + C * b,
      B * a + D * b,
      A * c + C * d,
      B * c + D * d,
      A * e + C * f + E,
      B * e + D * f + F,
    ]
  }

  const methods: Record<string, (...args: number[]) => unknown> = {
    save: () => {
      stack.push({ ...state, transform: [...state.transform] })
    },
    restore: () => {
      const s = stack.pop()
      if (s) state = s
    },
    scale: (x = 1, y = 1) => {
      mul(x, 0, 0, y, 0, 0)
    },
    translate: (x = 0, y = 0) => {
      mul(1, 0, 0, 1, x, y)
    },
    rotate: (r = 0) => {
      mul(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0)
    },
    getTransform: () => {
      const [a, b, c, d, e, f] = state.transform
      return { a, b, c, d, e, f }
    },
    createLinearGradient: () => gradient(calls),
    createRadialGradient: (...a) => {
      if ((a[2] ?? 0) < 0 || (a[5] ?? 0) < 0) throw new RangeError('negative radius')
      return gradient(calls)
    },
    arc: (...a) => {
      if ((a[2] ?? 0) < 0) throw new RangeError('negative radius')
    },
    arcTo: (...a) => {
      if ((a[4] ?? 0) < 0) throw new RangeError('negative radius')
    },
  }

  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop in state) return state[prop]
      if (prop === 'measureText') {
        return (text: string) => {
          calls.push(['measureText', text])
          return { width: text.length * fontSize(state.font) * 0.6 }
        }
      }
      const impl = methods[prop]
      return (...args: unknown[]) => {
        calls.push([prop, ...args])
        return impl ? impl(...(args as number[])) : undefined
      }
    },
    set(_t, prop, value: unknown) {
      if (typeof prop !== 'string') return false
      if (typeof value !== 'function') calls.push([`set:${prop}`, value])
      if (prop === 'globalAlpha') {
        if (typeof value === 'number' && value >= 0 && value <= 1)
          state.globalAlpha = value
        return true
      }
      state[prop] = value
      return true
    },
    deleteProperty(_t, prop) {
      if (typeof prop === 'string') Reflect.deleteProperty(state, prop)
      return true
    },
  })

  return { ctx, calls, depth: () => stack.length }
}

/** Every recorded call with a numeric argument that is not finite. */
export function nonFinite(calls: Call[]): Call[] {
  return calls.filter(([, ...args]) =>
    args.some((a) => typeof a === 'number' && !Number.isFinite(a)),
  )
}
