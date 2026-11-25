import { useEffect, useState } from 'react'
import { useEditor } from '../timeline/store'

/**
 * Window-level listeners for drag gestures (mousemove / mouseup on `window`)
 * that can't outlive their component.
 *
 * Drags attach listeners to `window` from an event handler and remove them on
 * mouse-up. If the component unmounts mid-drag (error boundary, layout swap),
 * nothing would remove them: the move handler would keep editing the timeline
 * and the gesture's undo step would stay open. Use `on` / `off` exactly like
 * window.addEventListener / removeEventListener; on unmount every listener
 * still attached is removed and an open undo step is closed.
 */
export interface WindowListeners {
  on<K extends keyof WindowEventMap>(
    type: K,
    fn: (ev: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void
  off<K extends keyof WindowEventMap>(
    type: K,
    fn: (ev: WindowEventMap[K]) => void,
  ): void
}

type Entry = { type: string; fn: EventListener }

function createScope(): WindowListeners & { dispose(): void } {
  const active = new Set<Entry>()
  const find = (type: string, fn: unknown) =>
    [...active].find((e) => e.type === type && e.fn === fn)
  return {
    on(type, fn, opts) {
      const listener = fn as EventListener
      window.addEventListener(type, listener, opts)
      active.add({ type, fn: listener })
    },
    off(type, fn) {
      window.removeEventListener(type, fn as EventListener)
      const e = find(type, fn)
      if (e) active.delete(e)
    },
    dispose() {
      if (active.size === 0) return
      for (const e of active) window.removeEventListener(e.type, e.fn)
      active.clear()
      // A drag was cut off: don't leave its undo step open.
      const st = useEditor.getState()
      if (st._interactionDepth > 0) st.resetInteraction()
    },
  }
}

export function useWindowListeners(): WindowListeners {
  const [scope] = useState(createScope)
  useEffect(() => () => scope.dispose(), [scope])
  return scope
}
