import { useEffect } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Traps keyboard focus inside `containerRef` while `active` is true.
 * - Moves focus into the container when it becomes active (unless something
 *   inside already has focus, e.g. an autoFocus input).
 * - Cycles Tab / Shift+Tab within the container.
 * - Restores focus to the element that was focused before activation when
 *   the trap deactivates (or the component unmounts).
 *
 * Components that only mount while open can omit `active` (defaults to true).
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active = true,
): void {
  useEffect(() => {
    if (!active) return
    const previousFocus = document.activeElement as HTMLElement | null

    // The container renders in the same commit that flips `active`, so the
    // ref is populated by the time this effect runs.
    const el = containerRef.current
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE)
      if (first) first.focus()
      else {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
        el.focus()
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const root = containerRef.current
      if (!root) return

      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const current = document.activeElement

      if (!root.contains(current)) {
        // Focus escaped (e.g. clicked outside) — pull it back in.
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey) {
        if (current === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (current === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      // Restore focus when the modal closes / unmounts.
      if (previousFocus && previousFocus.isConnected) previousFocus.focus()
    }
    // containerRef is a stable ref object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}
