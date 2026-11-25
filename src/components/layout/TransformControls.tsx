import {
  Crop,
  Crosshair,
  Expand,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  Shrink,
  type LucideIcon,
} from 'lucide-react'
import type { ID } from '../../lib/timeline/types'
import {
  fitSelection,
  flipSelection,
  positionSelection,
  resetSelection,
} from '../../lib/layout/actions'
import { POSITION_PRESETS, type PositionPreset } from '../../lib/layout/transformOps'

const BTN =
  'w-6 h-6 inline-flex items-center justify-center rounded text-muted hover:text-fg hover:bg-white/5 disabled:opacity-35 disabled:pointer-events-none'
const BTN_ON = 'bg-accent-soft text-accent-text hover:text-accent-text'

function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  pressed,
  data,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  data?: string
}) {
  return (
    <button
      type="button"
      className={BTN + (pressed ? ' ' + BTN_ON : '')}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      data-transform-action={data}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  )
}

/**
 * Flip H / V, Fit, Fill and Reset for `ids` (each object in place, one undo
 * step), plus optional Crop / Anchor mode toggles (preview toolbar).
 */
export function TransformControls({
  ids,
  crop,
  anchor,
}: {
  ids: readonly ID[]
  /** Crop-mode toggle (single croppable object in the preview). */
  crop?: { active: boolean; toggle: () => void } | undefined
  /** Anchor-mode toggle (single object in the preview). */
  anchor?: { active: boolean; toggle: () => void } | undefined
}) {
  const none = ids.length === 0
  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        icon={FlipHorizontal2}
        label="Flip horizontally"
        data="flip-h"
        disabled={none}
        onClick={() => {
          flipSelection('h', ids)
        }}
      />
      <IconButton
        icon={FlipVertical2}
        label="Flip vertically"
        data="flip-v"
        disabled={none}
        onClick={() => {
          flipSelection('v', ids)
        }}
      />
      <IconButton
        icon={Shrink}
        label="Fit to frame (keep aspect, centred)"
        data="fit"
        disabled={none}
        onClick={() => {
          fitSelection('fit', ids)
        }}
      />
      <IconButton
        icon={Expand}
        label="Fill frame (cover, centred)"
        data="fill"
        disabled={none}
        onClick={() => {
          fitSelection('fill', ids)
        }}
      />
      <IconButton
        icon={RotateCcw}
        label="Reset position, scale, rotation, anchor and crop"
        data="reset"
        disabled={none}
        onClick={() => {
          resetSelection(ids)
        }}
      />
      {(crop || anchor) && <span className="w-px h-4 bg-bd mx-1" aria-hidden />}
      {crop && (
        <IconButton
          icon={Crop}
          label={crop.active ? 'Finish cropping (Enter)' : 'Crop (C)'}
          data="crop"
          pressed={crop.active}
          onClick={crop.toggle}
        />
      )}
      {anchor && (
        <IconButton
          icon={Crosshair}
          label={
            anchor.active
              ? 'Hide the anchor point'
              : 'Move the anchor point (or hold Alt)'
          }
          data="anchor"
          pressed={anchor.active}
          onClick={anchor.toggle}
        />
      )}
    </div>
  )
}

const PRESET_LABEL: Record<PositionPreset, string> = {
  'top-left': 'Top left',
  top: 'Top centre',
  'top-right': 'Top right',
  left: 'Middle left',
  center: 'Centre',
  right: 'Middle right',
  'bottom-left': 'Bottom left',
  bottom: 'Bottom centre',
  'bottom-right': 'Bottom right',
}

/** 3×3 position preset picker (5 % margin from the frame edges). */
export function PositionPresets({ ids }: { ids: readonly ID[] }) {
  return (
    <div
      className="inline-grid grid-cols-3 gap-0.5 p-0.5 rounded border border-bd"
      role="group"
      aria-label="Position presets"
    >
      {POSITION_PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          className="w-3.5 h-3.5 rounded-sm bg-white/10 hover:bg-accent disabled:opacity-35"
          disabled={ids.length === 0}
          title={`Move to ${PRESET_LABEL[p].toLowerCase()}`}
          aria-label={PRESET_LABEL[p]}
          data-position-preset={p}
          onClick={() => {
            positionSelection(p, ids)
          }}
        />
      ))}
    </div>
  )
}
