import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  label: string
  value: number
  step?: number
  suffix?: string
  min?: number
  max?: number
  onCommit: (v: number) => void
  /** Called before the first value change of a drag-scrub (e.g. beginInteraction). */
  onScrubStart?: () => void
  /** Called when a drag-scrub that changed the value ends (e.g. endInteraction). */
  onScrubEnd?: () => void
  /** Read-only: no scrubbing or text entry. */
  disabled?: boolean
  /** Tooltip shown while disabled. */
  disabledHint?: string
}

/**
 * Label + number pair that supports:
 * - Horizontal pointer-drag on the label to scrub value (Shift = ×10, Alt = ×0.1)
 * - Double-click on the number to enter a text edit mode
 * - Relative expressions: "+10", "-5" are applied to current value
 */
export function ScrubbableInput({
  label,
  value,
  step = 0.01,
  suffix,
  min,
  max,
  onCommit,
  onScrubStart,
  onScrubEnd,
  disabled = false,
  disabledHint,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  const clamp = useCallback(
    (v: number) => {
      let r = v
      if (min !== undefined) r = Math.max(min, r)
      if (max !== undefined) r = Math.min(max, r)
      return r
    },
    [min, max],
  )

  const commitText = useCallback(
    (raw: string) => {
      const trimmed = raw.trim()
      let next: number
      if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
        const delta = parseFloat(trimmed)
        next = isNaN(delta) ? value : value + delta
      } else {
        next = parseFloat(trimmed)
        if (isNaN(next)) {
          setEditing(false)
          return
        }
      }
      onCommit(clamp(next))
      setEditing(false)
    },
    [value, onCommit, clamp],
  )

  // Focus the text input when entering edit mode.
  useEffect(() => {
    if (editing) {
      setDraft(value.toFixed(step < 1 ? 2 : 0))
      requestAnimationFrame(() => {
        inputRef.current?.select()
      })
    }
  }, [editing, value, step])

  // Pointer scrub on the label.
  const onLabelPointerDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      if (e.button !== 0 || disabled) return
      e.preventDefault()
      // Scrub relative to the value at drag start. `value` is captured once
      // here, so each move derives the absolute target from the running
      // offset rather than re-adding to a stale prop.
      const startValue = value
      let lastX = e.clientX
      let offset = 0 // accumulated, multiplier-weighted offset in value units
      let lastCommitted = startValue
      let started = false
      const span = e.currentTarget
      span.setPointerCapture(e.pointerId)
      span.style.cursor = 'ew-resize'

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - lastX
        lastX = ev.clientX
        const multiplier = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
        offset += dx * step * multiplier
        const next = clamp(startValue + Math.round(offset / step) * step)
        if (next === lastCommitted) return
        if (!started) {
          started = true
          onScrubStart?.()
        }
        lastCommitted = next
        onCommit(next)
      }

      const onUp = () => {
        span.style.cursor = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        if (started) onScrubEnd?.()
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [value, step, onCommit, clamp, onScrubStart, onScrubEnd, disabled],
  )

  const decimals = step < 1 ? 2 : 0

  return (
    <label
      className={
        'flex items-center justify-between gap-2 select-none' +
        (disabled ? ' opacity-50' : '')
      }
      title={disabled ? disabledHint : undefined}
    >
      <span
        ref={labelRef}
        className={
          'text-muted text-[11px] transition-colors ' +
          (disabled ? 'cursor-not-allowed' : 'cursor-ew-resize hover:text-fg')
        }
        title={disabled ? disabledHint : 'Drag to scrub · Shift=fast · Alt=slow'}
        onPointerDown={onLabelPointerDown}
      >
        {label}
      </span>
      <div className="flex items-center gap-1">
        {editing ? (
          <input
            ref={inputRef}
            className="w-16 bg-surface border border-accent rounded px-1.5 py-0.5 text-right font-mono text-[11px] focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitText(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
              if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
          />
        ) : (
          <span
            className={
              'w-16 bg-surface border border-bd rounded px-1.5 py-0.5 text-right font-mono text-[11px] transition-colors inline-block ' +
              (disabled ? 'cursor-not-allowed' : 'cursor-text hover:border-accent/60')
            }
            title={
              disabled ? disabledHint : 'Double-click to type a value (or +/- delta)'
            }
            onDoubleClick={() => {
              if (!disabled) setEditing(true)
            }}
          >
            {value.toFixed(decimals)}
          </span>
        )}
        {suffix && <span className="text-muted text-[10px]">{suffix}</span>}
      </div>
    </label>
  )
}
