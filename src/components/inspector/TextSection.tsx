import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Bold,
  Check,
  ChevronDown,
  Italic,
  Save,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Trash2,
  Underline,
  X,
} from 'lucide-react'
import { ScrubbableInput } from '../ui/ScrubbableInput'
import type { MediaSource } from '../../lib/timeline/types'
import { Section, SliderField } from './fields'
import {
  FONT_OPTIONS,
  fontOptionFor,
  nearestWeight,
  type FontOption,
} from '../../lib/text/fonts'
import {
  defaultShadowBlur,
  defaultShadowOffsetY,
  resolveTextStyle,
  TEXT_LIMITS,
  type RichTextStyle,
} from '../../lib/text/style'
import {
  deletePreset,
  listPresets,
  presetPatch,
  savePreset,
  type TextPreset,
} from '../../lib/text/presets'
import { formatColor, parseColor } from '../../lib/text/color'
import { measureTextLayout } from '../../lib/compositor/textRender'

export interface TextSectionProps {
  source: MediaSource
  /** Apply a style patch (wire to the store's undoable `updateTextStyle`). */
  onChange: (patch: Partial<RichTextStyle>) => void
  /** Start / end of a slider drag or scrub (e.g. begin/endInteraction). */
  onBeginEdit?: () => void
  onEndEdit?: () => void
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'Extra light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extra bold',
  900: 'Black',
}

const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const

const inputCls =
  'bg-surface border border-bd rounded px-1.5 py-1 text-[11px] focus:border-accent focus:outline-none'

let measureCtx: CanvasRenderingContext2D | null | undefined
/** Unwrapped width of a text (so turning wrapping on changes nothing yet). */
function naturalWidth(text: RichTextStyle): number | null {
  if (typeof document === 'undefined') return null
  if (measureCtx === undefined)
    measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return null
  return measureTextLayout(measureCtx, { ...text, boxWidth: undefined }).contentWidth
}

const noop = () => {}

/**
 * Inspector section for a text clip: content, text styles (presets),
 * character (font, size, weight, B/I/U, align, spacing, wrap box) and
 * appearance (fill, stroke, shadow, background). Holds no document state:
 * every edit goes through `onChange`.
 */
export function TextSection({
  source,
  onChange,
  onBeginEdit,
  onEndEdit,
}: TextSectionProps) {
  const text: RichTextStyle | undefined = source.text
  if (!text) return null
  return (
    <TextControls
      text={text}
      onChange={onChange}
      onBeginEdit={onBeginEdit ?? noop}
      onEndEdit={onEndEdit ?? noop}
    />
  )
}

function TextControls({
  text,
  onChange,
  onBeginEdit,
  onEndEdit,
}: {
  text: RichTextStyle
  onChange: (patch: Partial<RichTextStyle>) => void
  onBeginEdit: () => void
  onEndEdit: () => void
}) {
  const r = resolveTextStyle(text)
  const font = fontOptionFor(text.fontFamily)
  const weights: readonly number[] = font?.weights ?? ALL_WEIGHTS
  const weight = font ? nearestWeight(font, r.fontWeight) : r.fontWeight
  const scrub = { onScrubStart: onBeginEdit, onScrubEnd: onEndEdit }
  const slide = { onStart: onBeginEdit, onEnd: onEndEdit }
  const bold = r.fontWeight >= 600
  const shadowCol = parseColor(r.shadowColor, { hex: '#000000', alpha: 0.55 })
  const bgCol = parseColor(r.background ?? '#000000', { hex: '#000000', alpha: 1 })
  const toWeight = (w: number) => (font ? nearestWeight(font, w) : w)

  return (
    <>
      <Section label="Text">
        <label className="block space-y-1">
          <span className="text-muted text-[11px]">Content</span>
          <textarea
            value={text.content}
            onChange={(e) => onChange({ content: e.currentTarget.value })}
            rows={2}
            className="w-full bg-surface border border-bd rounded px-2 py-1 text-[11px] focus:border-accent focus:outline-none resize-y"
          />
        </label>
        <PresetRow text={text} onChange={onChange} />
      </Section>

      <Section label="Character">
        <FontPicker
          value={font}
          family={text.fontFamily}
          onPick={(o) =>
            onChange({ fontFamily: o.family, fontWeight: nearestWeight(o, weight) })
          }
        />
        <div className="grid grid-cols-2 gap-2">
          <ScrubbableInput
            label="Size"
            value={r.fontSize}
            step={1}
            suffix="px"
            min={8}
            max={TEXT_LIMITS.fontSize.max}
            {...scrub}
            onCommit={(v) => onChange({ fontSize: Math.round(v) })}
          />
          <label className="flex items-center gap-1.5 min-w-0">
            <span className="text-muted text-[11px] shrink-0">Weight</span>
            <select
              value={weight}
              disabled={weights.length < 2}
              onChange={(e) => onChange({ fontWeight: Number(e.currentTarget.value) })}
              className={inputCls + ' min-w-0 flex-1 disabled:opacity-50'}
              aria-label="Font weight"
            >
              {!weights.includes(weight) && (
                <option value={weight}>{String(weight)}</option>
              )}
              {weights.map((w) => (
                <option key={w} value={w}>
                  {WEIGHT_NAMES[w] ?? String(w)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-1">
          <ToggleButton
            label="Bold"
            active={bold}
            onClick={() => onChange({ fontWeight: toWeight(bold ? 400 : 700) })}
          >
            <Bold size={13} />
          </ToggleButton>
          <ToggleButton
            label="Italic"
            active={r.italic}
            onClick={() => onChange({ italic: !r.italic })}
          >
            <Italic size={13} />
          </ToggleButton>
          <ToggleButton
            label="Underline"
            active={r.underline}
            onClick={() => onChange({ underline: !r.underline })}
          >
            <Underline size={13} />
          </ToggleButton>
          <div className="w-px h-5 bg-bd mx-1" />
          {(
            [
              ['left', TextAlignStart, 'Align left'],
              ['center', TextAlignCenter, 'Align center'],
              ['right', TextAlignEnd, 'Align right'],
            ] as const
          ).map(([a, Icon, label]) => (
            <ToggleButton
              key={a}
              label={label}
              active={r.align === a}
              onClick={() => onChange({ align: a })}
            >
              <Icon size={13} />
            </ToggleButton>
          ))}
        </div>
        <SliderField
          label="Letter spacing"
          value={r.letterSpacing}
          min={-0.2}
          max={1}
          step={0.01}
          {...slide}
          format={(v) => `${v.toFixed(2)} em`}
          onInput={(v) => onChange({ letterSpacing: v })}
        />
        <SliderField
          label="Line height"
          value={r.lineHeight}
          min={0.7}
          max={3}
          step={0.05}
          {...slide}
          format={(v) => `${v.toFixed(2)}×`}
          onInput={(v) => onChange({ lineHeight: v })}
        />
        <div className="flex items-center gap-2 min-h-6">
          <Checkbox
            label="Wrap in box"
            checked={r.boxWidth !== null}
            onChange={(on) => {
              if (!on) {
                onChange({ boxWidth: undefined })
                return
              }
              const w = naturalWidth(text) ?? 800
              onChange({ boxWidth: Math.max(TEXT_LIMITS.boxWidth.min, Math.ceil(w)) })
            }}
          />
          {r.boxWidth !== null && (
            <div className="flex-1 min-w-0">
              <ScrubbableInput
                label="Width"
                value={Math.round(r.boxWidth)}
                step={1}
                suffix="px"
                min={TEXT_LIMITS.boxWidth.min}
                max={TEXT_LIMITS.boxWidth.max}
                {...scrub}
                onCommit={(v) => onChange({ boxWidth: Math.round(v) })}
              />
            </div>
          )}
        </div>
      </Section>

      <Section label="Appearance">
        <div className="flex items-center gap-3">
          <ColorField
            label="Fill"
            value={parseColor(r.color, { hex: '#ffffff', alpha: 1 }).hex}
            onChange={(hex) => onChange({ color: hex })}
          />
          <ColorField
            label="Stroke"
            value={parseColor(text.strokeColor, { hex: '#000000', alpha: 1 }).hex}
            onChange={(hex) =>
              onChange(
                r.strokeWidth > 0
                  ? { strokeColor: hex }
                  : { strokeColor: hex, strokeWidth: 2 },
              )
            }
          />
        </div>
        <ScrubbableInput
          label="Stroke width"
          value={r.strokeWidth}
          step={0.5}
          suffix="px"
          min={0}
          max={TEXT_LIMITS.strokeWidth.max}
          {...scrub}
          onCommit={(v) => onChange({ strokeWidth: Math.max(0, v) })}
        />

        <SubGroup
          label="Shadow"
          on={r.shadow}
          onToggle={(on) => onChange({ shadow: on })}
        >
          <ColorField
            label="Color"
            value={shadowCol.hex}
            onChange={(hex) =>
              onChange({ shadowColor: formatColor(hex, shadowCol.alpha) })
            }
          />
          <SliderField
            label="Opacity"
            value={Math.round(shadowCol.alpha * 100)}
            min={0}
            max={100}
            step={1}
            {...slide}
            format={(v) => `${String(Math.round(v))}%`}
            onInput={(v) =>
              onChange({ shadowColor: formatColor(shadowCol.hex, v / 100) })
            }
          />
          <ScrubbableInput
            label="Blur"
            value={Math.round(r.shadowBlur * 10) / 10}
            step={0.5}
            suffix="px"
            min={0}
            max={TEXT_LIMITS.shadowBlur.max}
            {...scrub}
            onCommit={(v) => onChange({ shadowBlur: v })}
          />
          <div className="grid grid-cols-2 gap-2">
            <ScrubbableInput
              label="Offset X"
              value={Math.round(r.shadowOffsetX * 10) / 10}
              step={0.5}
              min={TEXT_LIMITS.shadowOffset.min}
              max={TEXT_LIMITS.shadowOffset.max}
              {...scrub}
              onCommit={(v) => onChange({ shadowOffsetX: v })}
            />
            <ScrubbableInput
              label="Offset Y"
              value={Math.round(r.shadowOffsetY * 10) / 10}
              step={0.5}
              min={TEXT_LIMITS.shadowOffset.min}
              max={TEXT_LIMITS.shadowOffset.max}
              {...scrub}
              onCommit={(v) => onChange({ shadowOffsetY: v })}
            />
          </div>
          <button
            type="button"
            className="btn-ghost text-[10px] px-1.5 py-0.5"
            title={`Soft black, blur ${defaultShadowBlur(r.fontSize).toFixed(1)} px, offset 0 / ${defaultShadowOffsetY(r.fontSize).toFixed(1)} px`}
            onClick={() =>
              onChange({
                shadowColor: undefined,
                shadowBlur: undefined,
                shadowOffsetX: undefined,
                shadowOffsetY: undefined,
              })
            }
          >
            Reset shadow
          </button>
        </SubGroup>

        <SubGroup
          label="Background"
          on={r.background !== null}
          onToggle={(on) => onChange({ background: on ? bgCol.hex : undefined })}
        >
          <ColorField
            label="Color"
            value={bgCol.hex}
            onChange={(hex) => onChange({ background: hex })}
          />
          <SliderField
            label="Opacity"
            value={Math.round(r.backgroundOpacity * 100)}
            min={0}
            max={100}
            step={1}
            {...slide}
            format={(v) => `${String(Math.round(v))}%`}
            onInput={(v) => onChange({ backgroundOpacity: v / 100 })}
          />
          <SliderField
            label="Padding"
            value={r.backgroundPadding}
            min={0}
            max={1.5}
            step={0.05}
            {...slide}
            format={(v) => `${v.toFixed(2)} em`}
            onInput={(v) => onChange({ backgroundPadding: v })}
          />
          <ScrubbableInput
            label="Corner radius"
            value={r.backgroundRadius}
            step={1}
            suffix="px"
            min={0}
            max={TEXT_LIMITS.backgroundRadius.max}
            {...scrub}
            onCommit={(v) => onChange({ backgroundRadius: Math.max(0, Math.round(v)) })}
          />
        </SubGroup>
      </Section>
    </>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function ToggleButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={
        'w-7 h-6 flex items-center justify-center rounded border transition-colors ' +
        (active
          ? 'bg-accent/20 border-accent/40 text-accent-text'
          : 'border-bd text-muted hover:text-fg hover:bg-white/5')
      }
    >
      {children}
    </button>
  )
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted shrink-0 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  return (
    <label className="flex flex-1 items-center justify-between gap-2 min-w-0">
      <span className="text-muted text-[11px]">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="w-8 h-6 rounded bg-surface border border-bd cursor-pointer shrink-0"
      />
    </label>
  )
}

/** A titled on/off group; its controls show only while it's on. */
function SubGroup({
  label,
  on,
  onToggle,
  children,
}: {
  label: string
  on: boolean
  onToggle: (on: boolean) => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-bd bg-surface2/60">
      <div className="px-2 py-1.5">
        <Checkbox label={label} checked={on} onChange={onToggle} />
      </div>
      {on && <div className="px-2 pb-2 space-y-2">{children}</div>}
    </div>
  )
}

/** Font dropdown: each family is listed in its own typeface. */
function FontPicker({
  value,
  family,
  onPick,
}: {
  value: FontOption | undefined
  family: string
  onPick: (o: FontOption) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    // Focus the current option so arrow keys work straight away.
    const list = listRef.current
    const current =
      list?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      list?.querySelector<HTMLElement>('[role="option"]')
    current?.focus()
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const onListKey = (e: React.KeyboardEvent) => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    )
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next =
        e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)
      items[next]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const fallbackLabel = family.split(',')[0]?.replace(/["']/g, '').trim() || 'Custom'

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Font: ${value?.label ?? fallbackLabel}`}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 bg-surface border border-bd rounded px-2 py-1 hover:border-bd2 focus:border-accent focus:outline-none"
      >
        <span className="text-muted text-[11px] shrink-0">Font</span>
        <span
          className="flex-1 min-w-0 truncate text-left text-[13px] text-fg"
          style={{ fontFamily: value?.family ?? family }}
        >
          {value?.label ?? fallbackLabel}
        </span>
        <ChevronDown size={12} className="text-muted shrink-0" />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Fonts"
          onKeyDown={onListKey}
          className="absolute z-30 mt-1 w-full max-h-72 overflow-auto rounded-md border border-bd bg-surface2 shadow-xl py-1"
        >
          {FONT_OPTIONS.map((o) => {
            const selected = o.id === value?.id
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onPick(o)
                  setOpen(false)
                  buttonRef.current?.focus()
                }}
                className={
                  'w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-white/5 focus:bg-white/10 focus:outline-none ' +
                  (selected ? 'text-accent-text' : 'text-fg')
                }
              >
                <span className="w-3 shrink-0">{selected && <Check size={12} />}</span>
                <span
                  className="flex-1 truncate text-[15px]"
                  style={{ fontFamily: o.family }}
                >
                  {o.label}
                </span>
                <span className="text-[9px] uppercase tracking-wide text-muted">
                  {o.category}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Text styles: apply a preset, save the current style, delete own presets. */
function PresetRow({
  text,
  onChange,
}: {
  text: RichTextStyle
  onChange: (patch: Partial<RichTextStyle>) => void
}) {
  const [presets, setPresets] = useState<TextPreset[]>(listPresets)
  const [selectedId, setSelectedId] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const selected = useMemo(
    () => presets.find((p) => p.id === selectedId),
    [presets, selectedId],
  )
  const builtIns = presets.filter((p) => p.builtIn)
  const mine = presets.filter((p) => !p.builtIn)
  const deletable = selected !== undefined && !selected.builtIn

  const save = () => {
    const preset = savePreset(name, text)
    const next = listPresets()
    // Keep the new preset listed for this session even if storage failed.
    setPresets(next.some((p) => p.id === preset.id) ? next : [...next, preset])
    setSelectedId(preset.id)
    setNaming(false)
    setName('')
  }

  if (naming) {
    return (
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={name}
          maxLength={60}
          placeholder="Style name"
          aria-label="Style name"
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setNaming(false)
            }
          }}
          className={inputCls + ' flex-1 min-w-0'}
        />
        <button
          type="button"
          className="btn-ghost p-1"
          title="Save style"
          aria-label="Save style"
          onClick={save}
        >
          <Check size={13} />
        </button>
        <button
          type="button"
          className="btn-ghost p-1"
          title="Cancel"
          aria-label="Cancel"
          onClick={() => setNaming(false)}
        >
          <X size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <select
        value={selectedId}
        aria-label="Text style"
        title="Apply a text style (formatting only; the content is kept)"
        onChange={(e) => {
          const id = e.currentTarget.value
          setSelectedId(id)
          const p = presets.find((x) => x.id === id)
          if (p) onChange(presetPatch(p))
        }}
        className={inputCls + ' flex-1 min-w-0'}
      >
        <option value="">Text style…</option>
        <optgroup label="Built-in">
          {builtIns.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
        {mine.length > 0 && (
          <optgroup label="My styles">
            {mine.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button
        type="button"
        className="btn-ghost p-1"
        title="Save the current formatting as a text style"
        aria-label="Save style"
        onClick={() => {
          setName(deletable ? selected.name : '')
          setNaming(true)
        }}
      >
        <Save size={13} />
      </button>
      <button
        type="button"
        className="btn-ghost p-1 disabled:opacity-30 disabled:pointer-events-none"
        title={
          deletable
            ? `Delete “${selected.name}”`
            : 'Select one of your styles to delete it'
        }
        aria-label="Delete style"
        disabled={!deletable}
        onClick={() => {
          if (!deletable) return
          deletePreset(selected.id)
          setPresets(listPresets())
          setSelectedId('')
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
