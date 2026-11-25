import { useEffect, useRef, useState } from 'react'
import {
  Plus,
  Trash2,
  ZoomIn,
  Move,
  Sunset,
  Focus,
  Vibrate,
  Pipette,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useEditor } from '../../lib/timeline/store'
import type { Clip, MediaSource } from '../../lib/timeline/types'
import { clipDuration, clipEnd } from '../../lib/compositor/scene'
import {
  createChromaKey,
  createFade,
  createKenBurns,
  createShake,
  createSpotlight,
  createZoom,
  defaultZoomMode,
  zoomModesFor,
  type ZoomMode,
  EFFECT_LABELS,
  effectAllowedFor,
  MIN_EFFECT_LEN,
  isRangedEffect,
  type ChromaKeyEffect,
  type ClipEffect,
  type EffectPatch,
  type EffectType,
  type FadeEffect,
  type KenBurnsEffect,
  type RangedEffect,
  type ShakeEffect,
  type SpotlightEffect,
  type ZoomEffect,
} from '../../lib/effects/types'
import { freeZoomRange } from '../../lib/effects/edit'
import { fadeEdges, timelineToSourceRaw } from '../../lib/effects/timing'
import {
  isEffectSelected,
  useKeyPicker,
  useSelectedEffect,
} from '../../lib/effects/selection'
import { activePreviewEngine } from '../../lib/compositor/previewEngine'
import { ScrubbableInput } from '../ui/ScrubbableInput'
import { useToast } from '../ui/Toast'
import { Section, SliderField } from './fields'

/** Length of an effect added at the playhead (timeline seconds). */
const DEFAULT_LEN = 2.5

const ICONS: Record<EffectType, typeof ZoomIn> = {
  zoom: ZoomIn,
  kenBurns: Move,
  fade: Sunset,
  spotlight: Focus,
  shake: Vibrate,
  chromaKey: Pipette,
}

const MENU: EffectType[] = [
  'zoom',
  'kenBurns',
  'fade',
  'spotlight',
  'shake',
  'chromaKey',
]

const MENU_HINT: Partial<Record<EffectType, string>> = {
  zoom: 'Zoom in on a point for a while (starts at the playhead)',
  kenBurns: 'Slow pan and zoom across the whole clip',
  fade: 'Fade picture and sound in at the start / out at the end',
  spotlight: 'Highlight an area: blur and darken the rest',
  shake: 'Camera shake (starts at the playhead)',
  chromaKey: 'Make a colour (e.g. a green screen) transparent',
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const secs = (v: number) => `${v.toFixed(2)} s`
const times = (v: number) => `${v.toFixed(2)}×`

/** Where a new ranged effect starts: the playhead's source time, or the clip start. */
function sourceAtPlayhead(clip: Clip): number {
  const ph = useEditor.getState().playhead
  const inClip = ph >= clip.timelineStart && ph < clipEnd(clip)
  return inClip ? timelineToSourceRaw(clip, ph) : clip.sourceIn
}

export function EffectsSection({
  clip,
  source,
}: {
  clip: Clip
  source: MediaSource | undefined
}) {
  const addEffect = useEditor((s) => s.addEffect)
  const select = useSelectedEffect((s) => s.select)
  const toast = useToast()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const live = !!clip.isLive
  const kind = source?.kind ?? 'video'
  const effects = clip.effects ?? []
  const onOverlayTrack = useEditor(
    (s) => s.project.tracks.find((t) => t.id === clip.trackId)?.kind === 'overlay',
  )

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  function disabledReason(type: EffectType): string | null {
    if (live) return 'Recording — stop to edit'
    if (!effectAllowedFor(type, kind))
      return kind === 'audio'
        ? 'Only fades apply to audio clips'
        : 'Not available for text and element clips'
    if (type === 'chromaKey' && kind !== 'video' && kind !== 'animation')
      return 'Chroma key works on videos and animations'
    if (type === 'chromaKey' && effects.some((e) => e.type === 'chromaKey'))
      return 'This clip already has a chroma key'
    if (type === 'fade' && effects.some((e) => e.type === 'fade'))
      return 'This clip already has a fade'
    if (type === 'kenBurns' && effects.some((e) => e.type === 'kenBurns'))
      return 'This clip already has Ken Burns'
    return null
  }

  function build(type: EffectType): ClipEffect | string {
    const speed = Math.max(0.1, clip.speed || 1)
    const len = DEFAULT_LEN * speed // source seconds
    let start = Math.max(clip.sourceIn, sourceAtPlayhead(clip))
    switch (type) {
      case 'zoom': {
        const free = freeZoomRange(effects, start)
        if (!free) return 'There is already a zoom at the playhead.'
        start = Math.max(start, free.min)
        const end = Math.min(start + len, free.max, clip.sourceOut)
        if (end - start < Math.max(MIN_EFFECT_LEN, 0.2))
          return 'Not enough room here: move the playhead or shorten the next zoom.'
        return createZoom(start, end, {
          mode: defaultZoomMode(kind, onOverlayTrack),
          easeIn: Math.min(0.5, (end - start) / 3),
          easeOut: Math.min(0.5, (end - start) / 3),
        })
      }
      case 'spotlight':
      case 'shake': {
        let end = Math.min(start + len, clip.sourceOut)
        if (end - start < MIN_EFFECT_LEN) {
          end = clip.sourceOut
          start = Math.max(clip.sourceIn, end - len)
        }
        return type === 'spotlight'
          ? createSpotlight(start, end)
          : createShake(start, end)
      }
      case 'fade': {
        const half = clipDuration(clip) / 2
        return createFade({ in: Math.min(0.5, half), out: Math.min(0.5, half) })
      }
      case 'kenBurns':
        return createKenBurns()
      case 'chromaKey':
        return createChromaKey()
    }
  }

  function add(type: EffectType) {
    setMenuOpen(false)
    const fx = build(type)
    if (typeof fx === 'string') {
      toast.error(`Couldn't add ${EFFECT_LABELS[type].toLowerCase()}`, fx)
      return
    }
    const id = addEffect(clip.id, fx)
    if (!id) {
      toast.error(`Couldn't add ${EFFECT_LABELS[type].toLowerCase()}`)
      return
    }
    select({ clipId: clip.id, effectId: id })
  }

  return (
    <Section label="Effects">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1" ref={menuRef}>
          <button
            className="btn-soft !py-1 !px-2 text-[11px] w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={live}
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Plus size={12} /> Add effect
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute z-50 left-0 right-0 mt-1 bg-elevated border border-bd rounded-lg shadow-pop p-1"
            >
              {MENU.map((type) => {
                const Icon = ICONS[type]
                const reason = disabledReason(type)
                return (
                  <button
                    key={type}
                    role="menuitem"
                    disabled={!!reason}
                    title={reason ?? MENU_HINT[type]}
                    onClick={() => add(type)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-[11px] text-left text-fg/85 hover:bg-white/8 hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <Icon size={12} className="shrink-0 text-muted" />
                    {EFFECT_LABELS[type]}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {effectAllowedFor('zoom', kind) && (
          <button
            className="btn-ghost !py-1 !px-2 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={live}
            title="Add a 2.5 s zoom at the playhead, then click the preview to aim it"
            onClick={() => add('zoom')}
          >
            <ZoomIn size={12} /> Zoom here
          </button>
        )}
      </div>
      {effects.length === 0 ? (
        <div className="text-[10px] text-muted">
          No effects. Add a zoom, fade, spotlight or shake.
        </div>
      ) : (
        <div className="space-y-1.5">
          {effects.map((e) => (
            <EffectCard key={e.id} clip={clip} effect={e} live={live} />
          ))}
        </div>
      )}
    </Section>
  )
}

function rangeLabel(clip: Clip, e: RangedEffect): string {
  const speed = Math.max(0.1, clip.speed || 1)
  const start = (e.start - clip.sourceIn) / speed
  const len = (e.end - e.start) / speed
  return `${start.toFixed(1)}–${(start + len).toFixed(1)} s`
}

function EffectCard({
  clip,
  effect,
  live,
}: {
  clip: Clip
  effect: ClipEffect
  live: boolean
}) {
  const selected = useSelectedEffect((s) =>
    isEffectSelected(s.selected, clip.id, effect.id),
  )
  const select = useSelectedEffect((s) => s.select)
  const toggleEffect = useEditor((s) => s.toggleEffect)
  const removeEffect = useEditor((s) => s.removeEffect)
  const Icon = ICONS[effect.type]
  const outOfRange =
    isRangedEffect(effect) &&
    (effect.end <= clip.sourceIn + 1e-6 || effect.start >= clip.sourceOut - 1e-6)

  return (
    <div
      className={
        'rounded-md border transition-colors ' +
        (selected ? 'border-accent/60 bg-accent/10' : 'border-bd bg-surface/60')
      }
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer"
        onClick={() =>
          select(selected ? null : { clipId: clip.id, effectId: effect.id })
        }
      >
        <Icon size={12} className="shrink-0 text-violet-400" />
        <span
          className={
            'text-[11px] font-medium truncate ' + (effect.enabled ? '' : 'opacity-50')
          }
        >
          {EFFECT_LABELS[effect.type]}
        </span>
        {isRangedEffect(effect) && (
          <span className="text-[10px] font-mono text-muted truncate">
            {outOfRange ? 'trimmed out' : rangeLabel(clip, effect)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            className="btn-ghost !p-1 disabled:opacity-40"
            disabled={live}
            title={effect.enabled ? 'Turn off' : 'Turn on'}
            aria-pressed={effect.enabled}
            onClick={(ev) => {
              ev.stopPropagation()
              toggleEffect(clip.id, effect.id)
            }}
          >
            {effect.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            className="btn-ghost !p-1 text-danger hover:text-danger-hover disabled:opacity-40"
            disabled={live}
            title="Delete effect"
            onClick={(ev) => {
              ev.stopPropagation()
              removeEffect(clip.id, effect.id)
              if (selected) select(null)
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {selected && !live && (
        <div className="px-2 pb-2 pt-0.5 space-y-2 border-t border-bd/60">
          <EffectFields clip={clip} effect={effect} />
        </div>
      )}
    </div>
  )
}

function useEffectEditor(clip: Clip, effect: ClipEffect) {
  const updateEffect = useEditor((s) => s.updateEffect)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const endInteraction = useEditor((s) => s.endInteraction)
  const toast = useToast()
  const update = (patch: EffectPatch, coalesceKey?: string) => {
    if (!updateEffect(clip.id, effect.id, patch, coalesceKey) && effect.type === 'zoom')
      toast.error('Zooms can’t overlap', 'Move or shorten the neighbouring zoom first.')
  }
  /** Props for a SliderField editing one numeric field (one undo step per drag). */
  const slider = (onInput: (v: number) => void) => ({
    onInput,
    onStart: beginInteraction,
    onEnd: endInteraction,
  })
  const scrub = { onScrubStart: beginInteraction, onScrubEnd: endInteraction }
  return { update, slider, scrub }
}

function EffectFields({ clip, effect }: { clip: Clip; effect: ClipEffect }) {
  switch (effect.type) {
    case 'zoom':
      return <ZoomFields clip={clip} effect={effect} />
    case 'kenBurns':
      return <KenBurnsFields clip={clip} effect={effect} />
    case 'fade':
      return <FadeFields clip={clip} effect={effect} />
    case 'spotlight':
      return <SpotlightFields clip={clip} effect={effect} />
    case 'shake':
      return <ShakeFields clip={clip} effect={effect} />
    case 'chromaKey':
      return <ChromaFields clip={clip} effect={effect} />
  }
}

function ChromaFields({ clip, effect }: { clip: Clip; effect: ChromaKeyEffect }) {
  const { update, slider } = useEffectEditor(clip, effect)
  const toast = useToast()
  const picking = useKeyPicker((s) => s.picking)
  const armed = isEffectSelected(picking, clip.id, effect.id)
  // The native colour picker fires onChange continuously while dragging:
  // coalesce the burst into one undo step. (Unlike an open interaction this
  // never blocks Ctrl+Z right after picking.)
  function setColor(hex: string) {
    update({ color: hex }, `key-colour:${effect.id}`)
  }
  return (
    <>
      <label className="flex items-center justify-between gap-2">
        <span className="text-muted text-[11px]">Key colour</span>
        <input
          type="color"
          value={effect.color}
          onChange={(e) => setColor(e.currentTarget.value)}
          className="w-8 h-6 rounded bg-surface border border-bd cursor-pointer"
        />
      </label>
      <div className="flex items-center gap-1">
        <button
          className={
            'btn-soft flex-1 !py-1 !px-2 text-[11px] justify-center ' +
            (armed ? 'ring-1 ring-accent' : '')
          }
          title="Then click a colour in the preview (Esc to cancel)"
          onClick={() => {
            const k = useKeyPicker.getState()
            if (armed) k.cancel()
            else k.start({ clipId: clip.id, effectId: effect.id })
          }}
        >
          <Pipette size={12} /> {armed ? 'Click the preview…' : 'Pick from preview'}
        </button>
        <button
          className="btn-ghost !py-1 !px-2 text-[11px]"
          title="Guess the key colour from the frame's edges"
          onClick={() => {
            const hex = activePreviewEngine()?.suggestColor(clip.id)
            if (!hex) {
              toast.info('Move the playhead onto this clip first')
              return
            }
            const st = useEditor.getState()
            st.beginInteraction()
            update({ color: hex })
            st.endInteraction()
          }}
        >
          Auto
        </button>
      </div>
      <SliderField
        label="Similarity"
        value={effect.similarity}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        {...slider((v) => update({ similarity: v }))}
      />
      <SliderField
        label="Smoothness"
        value={effect.smoothness}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        {...slider((v) => update({ smoothness: v }))}
      />
      <SliderField
        label="Spill removal"
        value={effect.spill}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        {...slider((v) => update({ spill: v }))}
      />
      <Hint>
        Keys out the colour for the whole clip. Use Pick, then click the background on
        the preview.
      </Hint>
    </>
  )
}

/** Start / length of a ranged effect, shown in timeline seconds from the clip start. */
function RangeFields({ clip, effect }: { clip: Clip; effect: RangedEffect }) {
  const { update, scrub } = useEffectEditor(clip, effect)
  const speed = Math.max(0.1, clip.speed || 1)
  const start = (effect.start - clip.sourceIn) / speed
  const len = (effect.end - effect.start) / speed
  return (
    <div className="grid grid-cols-2 gap-2">
      <ScrubbableInput
        label="Start"
        value={start}
        step={0.05}
        suffix="s"
        {...scrub}
        onCommit={(v) => {
          const s = Math.max(0, clip.sourceIn + v * speed)
          update({ start: s, end: s + (effect.end - effect.start) })
        }}
      />
      <ScrubbableInput
        label="Length"
        value={len}
        step={0.05}
        suffix="s"
        min={MIN_EFFECT_LEN}
        {...scrub}
        onCommit={(v) =>
          update({ end: effect.start + Math.max(MIN_EFFECT_LEN, v * speed) })
        }
      />
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] text-muted leading-snug">{children}</div>
}

const ZOOM_MODE_LABEL: Record<ZoomMode, { label: string; hint: string }> = {
  inside: {
    label: 'Inside frame',
    hint: 'Zoom into the picture; the clip keeps its size on screen (best for full-screen recordings)',
  },
  grow: {
    label: 'Grow object',
    hint: 'The object itself gets bigger on screen, around the focus point',
  },
  frame: {
    label: 'Whole video',
    hint: 'The whole video zooms in, centred on the focus point of this object',
  },
}

function ZoomFields({ clip, effect }: { clip: Clip; effect: ZoomEffect }) {
  const { update, slider } = useEffectEditor(clip, effect)
  const kind = useEditor(
    (s) => s.project.sources.find((x) => x.id === clip.sourceId)?.kind ?? 'video',
  )
  const modes = zoomModesFor(kind)
  const len = effect.end - effect.start
  return (
    <>
      <div className="space-y-1">
        <span className="text-muted text-[11px]">Zoom</span>
        <div className="flex gap-1" role="radiogroup" aria-label="Zoom mode">
          {modes.map((m) => {
            const on =
              effect.mode === m || (!modes.includes(effect.mode) && m === modes[0])
            return (
              <button
                key={m}
                role="radio"
                aria-checked={on}
                title={ZOOM_MODE_LABEL[m].hint}
                onClick={() => {
                  if (!on) update({ mode: m })
                }}
                className={
                  'flex-1 rounded px-1.5 py-1 text-[10.5px] border transition-colors ' +
                  (on
                    ? 'bg-accent/20 border-accent/50 text-accent-text'
                    : 'border-bd text-muted hover:text-fg hover:bg-white/5')
                }
              >
                {ZOOM_MODE_LABEL[m].label}
              </button>
            )
          })}
        </div>
        <p className="text-[10px] text-muted leading-snug">
          {
            ZOOM_MODE_LABEL[
              modes.includes(effect.mode) ? effect.mode : (modes[0] ?? 'grow')
            ].hint
          }
        </p>
      </div>
      <RangeFields clip={clip} effect={effect} />
      <SliderField
        label="Zoom level"
        value={effect.scale}
        min={1}
        max={4}
        step={0.05}
        format={times}
        {...slider((v) => update({ scale: v }))}
      />
      <SliderField
        label="Focus X"
        value={effect.focusX}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        {...slider((v) => update({ focusX: v }))}
      />
      <SliderField
        label="Focus Y"
        value={effect.focusY}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        {...slider((v) => update({ focusY: v }))}
      />
      <SliderField
        label="Zoom-in time"
        value={effect.easeIn}
        min={0}
        max={Math.max(0.01, Math.min(3, len))}
        step={0.05}
        format={secs}
        {...slider((v) => update({ easeIn: v }))}
      />
      <SliderField
        label="Zoom-out time"
        value={effect.easeOut}
        min={0}
        max={Math.max(0.01, Math.min(3, len))}
        step={0.05}
        format={secs}
        {...slider((v) => update({ easeOut: v }))}
      />
      <Hint>
        Click the preview to aim the zoom. A zoom that starts right where another ends
        pans between them instead of zooming out.
      </Hint>
    </>
  )
}

function KenBurnsFields({ clip, effect }: { clip: Clip; effect: KenBurnsEffect }) {
  const { update, slider } = useEffectEditor(clip, effect)
  return (
    <>
      <div className="grid grid-cols-2 gap-x-2 gap-y-2">
        <SliderField
          label="Start zoom"
          value={effect.fromScale}
          min={1}
          max={3}
          step={0.01}
          format={times}
          {...slider((v) => update({ fromScale: v }))}
        />
        <SliderField
          label="End zoom"
          value={effect.toScale}
          min={1}
          max={3}
          step={0.01}
          format={times}
          {...slider((v) => update({ toScale: v }))}
        />
        <SliderField
          label="Start X"
          value={effect.fromX}
          min={0}
          max={1}
          step={0.01}
          format={pct}
          {...slider((v) => update({ fromX: v }))}
        />
        <SliderField
          label="End X"
          value={effect.toX}
          min={0}
          max={1}
          step={0.01}
          format={pct}
          {...slider((v) => update({ toX: v }))}
        />
        <SliderField
          label="Start Y"
          value={effect.fromY}
          min={0}
          max={1}
          step={0.01}
          format={pct}
          {...slider((v) => update({ fromY: v }))}
        />
        <SliderField
          label="End Y"
          value={effect.toY}
          min={0}
          max={1}
          step={0.01}
          format={pct}
          {...slider((v) => update({ toY: v }))}
        />
      </div>
      <Hint>Pans and zooms slowly from the start framing to the end framing.</Hint>
    </>
  )
}

function FadeFields({ clip, effect }: { clip: Clip; effect: FadeEffect }) {
  const { update, slider } = useEffectEditor(clip, effect)
  const edges = useEditor(useShallow((s) => fadeEdges(s.project, clip.id)))
  const max = Math.max(0.1, Math.min(10, clipDuration(clip)))
  return (
    <>
      <SliderField
        label={edges.fadeIn ? 'Fade in' : 'Fade in (transition used instead)'}
        value={effect.in}
        min={0}
        max={max}
        step={0.05}
        format={secs}
        disabled={!edges.fadeIn}
        {...slider((v) => update({ in: v }))}
      />
      <SliderField
        label={edges.fadeOut ? 'Fade out' : 'Fade out (transition used instead)'}
        value={effect.out}
        min={0}
        max={max}
        step={0.05}
        format={secs}
        disabled={!edges.fadeOut}
        {...slider((v) => update({ out: v }))}
      />
      <Hint>Fades both picture (from/to black) and sound.</Hint>
    </>
  )
}

function SpotlightFields({ clip, effect }: { clip: Clip; effect: SpotlightEffect }) {
  const { update, slider } = useEffectEditor(clip, effect)
  return (
    <>
      <RangeFields clip={clip} effect={effect} />
      <div className="flex items-center gap-1">
        {(['ellipse', 'rect'] as const).map((shape) => (
          <button
            key={shape}
            className={
              'flex-1 py-1 rounded text-[10px] border transition-colors ' +
              (effect.shape === shape
                ? 'bg-accent/20 border-accent/40 text-accent-text'
                : 'border-bd text-muted hover:text-fg')
            }
            onClick={() => update({ shape })}
          >
            {shape === 'ellipse' ? 'Ellipse' : 'Rectangle'}
          </button>
        ))}
      </div>
      <SliderField
        label="Darken rest"
        value={effect.dim}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        {...slider((v) => update({ dim: v }))}
      />
      <SliderField
        label="Blur rest"
        value={effect.blur}
        min={0}
        max={40}
        step={0.5}
        format={(v) => `${v.toFixed(1)} px`}
        {...slider((v) => update({ blur: v }))}
      />
      <SliderField
        label="Soft edge"
        value={effect.feather}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        {...slider((v) => update({ feather: v }))}
      />
      <div className="grid grid-cols-2 gap-x-2 gap-y-2">
        <SliderField
          label="Width"
          value={effect.w}
          min={0.02}
          max={1}
          step={0.01}
          format={pct}
          {...slider((v) => update({ w: v, x: Math.min(effect.x, 1 - v) }))}
        />
        <SliderField
          label="Height"
          value={effect.h}
          min={0.02}
          max={1}
          step={0.01}
          format={pct}
          {...slider((v) => update({ h: v, y: Math.min(effect.y, 1 - v) }))}
        />
      </div>
      <Hint>Drag the box on the preview to move it; drag its corners to resize.</Hint>
    </>
  )
}

function ShakeFields({ clip, effect }: { clip: Clip; effect: ShakeEffect }) {
  const { update, slider } = useEffectEditor(clip, effect)
  return (
    <>
      <RangeFields clip={clip} effect={effect} />
      <SliderField
        label="Intensity"
        value={effect.intensity}
        min={1}
        max={60}
        step={1}
        format={(v) => `${v.toFixed(0)} px`}
        {...slider((v) => update({ intensity: v }))}
      />
      <SliderField
        label="Speed"
        value={effect.frequency}
        min={1}
        max={30}
        step={0.5}
        format={(v) => `${v.toFixed(1)} Hz`}
        {...slider((v) => update({ frequency: v }))}
      />
      <Hint>The picture zooms in slightly so the shake never shows black edges.</Hint>
    </>
  )
}
