import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  type LucideIcon,
} from 'lucide-react'
import type { AlignEdge, DistributeAxis } from '../../lib/layout/align'
import {
  alignSelection,
  distributeSelection,
  effectiveRelativeTo,
  useAlignPrefs,
} from '../../lib/layout/actions'

const ALIGN_BUTTONS: { edge: AlignEdge; icon: LucideIcon; label: string }[] = [
  { edge: 'left', icon: AlignStartVertical, label: 'Align left' },
  { edge: 'hcenter', icon: AlignCenterVertical, label: 'Align horizontal centres' },
  { edge: 'right', icon: AlignEndVertical, label: 'Align right' },
  { edge: 'top', icon: AlignStartHorizontal, label: 'Align top' },
  { edge: 'vmiddle', icon: AlignCenterHorizontal, label: 'Align vertical middles' },
  { edge: 'bottom', icon: AlignEndHorizontal, label: 'Align bottom' },
]

const DISTRIBUTE_BUTTONS: { axis: DistributeAxis; icon: LucideIcon; label: string }[] =
  [
    {
      axis: 'h',
      icon: AlignHorizontalDistributeCenter,
      label: 'Distribute horizontally',
    },
    { axis: 'v', icon: AlignVerticalDistributeCenter, label: 'Distribute vertically' },
  ]

/**
 * Align (6) + distribute (2) buttons and the "relative to Frame / Selection"
 * toggle. `count` = selected objects visible at the playhead.
 */
export function AlignControls({
  count,
  disabledHint,
}: {
  count: number
  /** Shown as the tooltip when nothing can be aligned (count = 0). */
  disabledHint?: string
}) {
  const pref = useAlignPrefs((s) => s.relativeTo)
  const setPref = useAlignPrefs((s) => s.setRelativeTo)
  const relativeTo = effectiveRelativeTo(pref, count)
  const none = count === 0
  const btn =
    'w-6 h-6 inline-flex items-center justify-center rounded text-muted hover:text-fg hover:bg-white/5 disabled:opacity-35 disabled:pointer-events-none'
  const hint = (label: string) => (none && disabledHint ? disabledHint : label)

  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {ALIGN_BUTTONS.map(({ edge, icon: Icon, label }) => (
        <button
          key={edge}
          type="button"
          className={btn}
          disabled={none}
          title={hint(`${label} (to ${relativeTo})`)}
          aria-label={label}
          onClick={() => {
            alignSelection(edge, relativeTo)
          }}
        >
          <Icon size={14} />
        </button>
      ))}
      <span className="w-px h-4 bg-bd mx-1" aria-hidden />
      {DISTRIBUTE_BUTTONS.map(({ axis, icon: Icon, label }) => (
        <button
          key={axis}
          type="button"
          className={btn}
          disabled={count < 3}
          title={count < 3 ? `${label} — select 3 or more objects` : label}
          aria-label={label}
          onClick={() => {
            distributeSelection(axis)
          }}
        >
          <Icon size={14} />
        </button>
      ))}
      <span className="w-px h-4 bg-bd mx-1" aria-hidden />
      <div
        className="inline-flex rounded border border-bd overflow-hidden text-[10px]"
        role="group"
        aria-label="Align relative to"
      >
        {(['frame', 'selection'] as const).map((v) => (
          <button
            key={v}
            type="button"
            disabled={none || (v === 'selection' && count < 2)}
            aria-pressed={relativeTo === v}
            title={
              v === 'frame'
                ? 'Align to the frame'
                : count < 2
                  ? 'Align to the selection — select 2 or more objects'
                  : 'Align to the selection bounds'
            }
            className={
              'px-1.5 h-5 disabled:opacity-35 disabled:pointer-events-none ' +
              (relativeTo === v
                ? 'bg-accent-soft text-accent-text'
                : 'text-muted hover:text-fg hover:bg-white/5')
            }
            onClick={() => {
              setPref(v)
            }}
          >
            {v === 'frame' ? 'Frame' : 'Selection'}
          </button>
        ))}
      </div>
    </div>
  )
}
