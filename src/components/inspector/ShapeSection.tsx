import { useEditor } from '../../lib/timeline/store'
import type { MediaSource, ShapeType } from '../../lib/timeline/types'
import {
  MAX_SHAPE_STROKE,
  SHAPE_LABELS,
  SHAPE_TYPES,
  defaultShape,
  isNoColor,
  isStrokeShape,
} from '../../lib/shapes'
import { SHAPE_ICONS } from '../shapeIcons'
import { Section, SliderField } from './fields'

/** `<input type="color">` needs #rrggbb. */
function hexOr(c: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : fallback
}

/**
 * Inspector section for a shape clip: type, fill (or none), stroke colour
 * and width, and the corner radius of rectangles. Edits are undoable; quick
 * runs on the same shape (colour / slider drags) are one undo step.
 */
export function ShapeSection({ source }: { source: MediaSource }) {
  const updateShape = useEditor((s) => s.updateShape)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const endInteraction = useEditor((s) => s.endInteraction)
  const shape = source.shape
  if (!shape) return null
  const strokeOnly = isStrokeShape(shape.type)
  const noFill = isNoColor(shape.fill)
  const fallbackFill = defaultShape(shape.type === 'ellipse' ? 'ellipse' : 'rect').fill
  const maxRadius = Math.floor(Math.min(shape.width, shape.height) / 2)

  const setType = (type: ShapeType) => {
    if (type === shape.type) return
    // Lines / arrows need a stroke; filled shapes keep their colours.
    // Switching between the two families takes the new type's box size.
    const def = defaultShape(type)
    const patch: Parameters<typeof updateShape>[1] = { type }
    if (isStrokeShape(type) !== strokeOnly) {
      patch.width = def.width
      patch.height = def.height
    }
    if (isStrokeShape(type) && shape.strokeWidth <= 0)
      patch.strokeWidth = def.strokeWidth
    if (!isStrokeShape(type) && isNoColor(shape.fill) && shape.strokeWidth <= 0)
      patch.fill = def.fill
    updateShape(source.id, patch)
  }

  return (
    <Section label={`Shape · ${SHAPE_LABELS[shape.type]}`}>
      <div
        className="grid grid-cols-4 gap-1"
        role="radiogroup"
        aria-label="Shape type"
        data-shape-type
      >
        {SHAPE_TYPES.map((type) => {
          const Icon = SHAPE_ICONS[type]
          const on = type === shape.type
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={SHAPE_LABELS[type]}
              title={SHAPE_LABELS[type]}
              onClick={() => setType(type)}
              className={
                'h-7 inline-flex items-center justify-center rounded border ' +
                (on
                  ? 'border-accent/60 bg-accent-soft text-accent-text'
                  : 'border-bd text-muted hover:text-fg hover:bg-white/5')
              }
            >
              <Icon size={14} />
            </button>
          )
        })}
      </div>
      {!strokeOnly && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted text-[11px]">Fill</span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={noFill}
                data-shape-no-fill
                onChange={(e) =>
                  updateShape(source.id, {
                    fill: e.currentTarget.checked ? 'transparent' : fallbackFill,
                  })
                }
              />
              No fill
            </label>
            <input
              type="color"
              aria-label="Fill colour"
              data-shape-fill
              value={hexOr(shape.fill, fallbackFill)}
              disabled={noFill}
              onChange={(e) => updateShape(source.id, { fill: e.currentTarget.value })}
              className="w-8 h-6 rounded bg-surface border border-bd cursor-pointer disabled:opacity-40"
            />
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted text-[11px]">
          {strokeOnly ? 'Colour' : 'Stroke'}
        </span>
        <input
          type="color"
          aria-label="Stroke colour"
          data-shape-stroke
          value={hexOr(shape.stroke, '#ffffff')}
          onChange={(e) => updateShape(source.id, { stroke: e.currentTarget.value })}
          className="w-8 h-6 rounded bg-surface border border-bd cursor-pointer"
        />
      </div>
      <SliderField
        label={strokeOnly ? 'Thickness' : 'Stroke width'}
        value={shape.strokeWidth}
        min={strokeOnly ? 1 : 0}
        max={Math.min(MAX_SHAPE_STROKE, 100)}
        step={1}
        onInput={(v) => updateShape(source.id, { strokeWidth: v })}
        onStart={beginInteraction}
        onEnd={endInteraction}
        format={(v) => `${v.toFixed(0)} px`}
      />
      {shape.type === 'rect' && (
        <SliderField
          label="Corner radius"
          value={Math.min(shape.radius, maxRadius)}
          min={0}
          max={maxRadius}
          step={1}
          onInput={(v) => updateShape(source.id, { radius: v })}
          onStart={beginInteraction}
          onEnd={endInteraction}
          format={(v) => `${v.toFixed(0)} px`}
        />
      )}
    </Section>
  )
}
