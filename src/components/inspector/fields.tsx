import { Diamond } from 'lucide-react'

/** Shared Inspector building blocks (also used by inspector/EffectsSection). */

export function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted font-semibold">
        {label}
      </div>
      {children}
    </div>
  )
}

export function KfButton({
  active,
  disabled,
  onToggle,
}: {
  active?: boolean | undefined
  disabled?: boolean | undefined
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={
        disabled
          ? 'Move playhead inside clip to keyframe'
          : active
            ? 'Remove keyframe at playhead'
            : 'Add keyframe at playhead'
      }
      className={
        'w-4 h-4 flex items-center justify-center rounded transition-colors shrink-0 ' +
        (active ? 'text-accent-text' : 'text-muted hover:text-fg') +
        (disabled ? ' opacity-30 cursor-not-allowed' : '')
      }
    >
      <Diamond size={10} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}

export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onInput,
  onStart,
  onEnd,
  format,
  kfActive,
  kfDisabled,
  onKfToggle,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onInput: (v: number) => void
  onStart: () => void
  onEnd: () => void
  format: (v: number) => string
  kfActive?: boolean
  kfDisabled?: boolean
  onKfToggle?: () => void
  disabled?: boolean
}) {
  return (
    <div className={'space-y-1' + (disabled ? ' opacity-50' : '')}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-muted text-[11px]">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px]">{format(value)}</span>
          {onKfToggle && (
            <KfButton active={kfActive} disabled={kfDisabled} onToggle={onKfToggle} />
          )}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={onStart}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onChange={(e) => onInput(parseFloat(e.currentTarget.value))}
        className="w-full accent-accent disabled:cursor-not-allowed"
      />
    </div>
  )
}

/** A field followed by its keyframe toggle. */
export function KfRow({
  kfActive,
  kfDisabled,
  onKfToggle,
  children,
}: {
  kfActive: boolean
  kfDisabled: boolean
  onKfToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      <div className="flex-1 min-w-0">{children}</div>
      <KfButton active={kfActive} disabled={kfDisabled} onToggle={onKfToggle} />
    </div>
  )
}
