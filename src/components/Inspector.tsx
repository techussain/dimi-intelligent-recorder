import { Trash2, Combine } from 'lucide-react'
import { ScrubbableInput } from './ui/ScrubbableInput'
import { useShallow } from 'zustand/react/shallow'
import { useEditor } from '../lib/timeline/store'
import type { Clip, ColorAdjust, KeyframeProp } from '../lib/timeline/types'
import { TranscriptSection } from './TranscriptSection'
import { SilenceSection } from './SilenceSection'
import { useMergeClips } from './MergeProgress'
import { useMergeJob } from '../lib/edit/mergeClips'
import { Section, SliderField } from './inspector/fields'
import { TransformSection } from './inspector/TransformSection'
import { EffectsSection } from './inspector/EffectsSection'
import { ElementSection } from './inspector/ElementSection'
import { ShapeSection } from './inspector/ShapeSection'
import { TextSection } from './inspector/TextSection'
import { AlignControls } from './layout/AlignControls'
import { activeVisualClips } from '../lib/layout/geometry'

export function Inspector() {
  // Subscribe only to the selected clips — re-render only when a
  // selected clip's own data changes, not on every clip move elsewhere.
  const removeClip = useEditor((s) => s.removeClip)
  const mergeClips = useMergeClips()
  const merging = useMergeJob((s) => s.job !== null)
  const selected = useEditor(
    useShallow((s) => s.project.clips.filter((c) => s.selection.includes(c.id))),
  )
  // Align row: shown when a selected clip is a visual on a video/overlay
  // track; it acts on the ones visible at the playhead.
  const hasVisual = useEditor((s) =>
    s.project.clips.some((c) => {
      if (!s.selection.includes(c.id)) return false
      const track = s.project.tracks.find((t) => t.id === c.trackId)
      if (!track || (track.kind !== 'video' && track.kind !== 'overlay')) return false
      const src = s.project.sources.find((x) => x.id === c.sourceId)
      return !!src && src.kind !== 'audio'
    }),
  )
  const visibleCount = useEditor(
    (s) =>
      activeVisualClips(s.project, s.playhead).filter((v) =>
        s.selection.includes(v.clip.id),
      ).length,
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-bd flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {selected.length ? `${selected.length} selected` : 'Nothing selected'}
        </span>
        {selected.length >= 2 && (
          <button
            onClick={() => mergeClips(selected.map((c) => c.id))}
            disabled={merging || selected.some((c) => c.isLive)}
            className="btn-soft !py-0.5 !px-2 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
            title="Render these clips into one new clip you can transcribe as a whole"
          >
            <Combine size={12} /> Merge
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3 text-xs">
        {hasVisual && (
          <div className="rounded-lg border border-bd bg-surface2/60 px-2.5 py-2 space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.08em] text-muted font-semibold">
              Align
            </div>
            <AlignControls
              count={visibleCount}
              disabledHint="Move the playhead over the selected clip to align it"
            />
          </div>
        )}
        {selected.length === 0 ? (
          <div className="text-center text-muted pt-10">
            Select a clip to edit its properties.
          </div>
        ) : (
          selected.map((c) => (
            <ClipCard key={c.id} clip={c} onRemove={() => removeClip(c.id)} />
          ))
        )}
      </div>
    </div>
  )
}

/** Tolerance (seconds) for "keyframe at playhead" — matches the store. */
const KF_TOL = 1 / 240
const KF_PROPS: KeyframeProp[] = [
  'opacity',
  'volume',
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
]
const LIVE_HINT = 'Recording — stop to edit'

function ClipCard({ clip, onRemove }: { clip: Clip; onRemove: () => void }) {
  const updateClip = useEditor((s) => s.updateClip)
  const setColor = useEditor((s) => s.setColor)
  const setKeyframe = useEditor((s) => s.setKeyframe)
  const removeKeyframe = useEditor((s) => s.removeKeyframe)
  const source = useEditor((s) => s.project.sources.find((x) => x.id === clip.sourceId))
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const endInteraction = useEditor((s) => s.endInteraction)
  const updateTextStyle = useEditor((s) => s.updateTextStyle)
  // One drag-scrub = one undo entry.
  const scrub = { onScrubStart: beginInteraction, onScrubEnd: endInteraction }

  const durSec = (clip.sourceOut - clip.sourceIn) / (clip.speed || 1)
  const live = !!clip.isLive
  // Only media with a real length bounds the trim-out; stills and text don't.
  const maxOut =
    source &&
    (source.kind === 'video' ||
      source.kind === 'audio' ||
      (source.kind === 'animation' && !clip.loop)) &&
    source.duration > 0
      ? source.duration
      : undefined
  // Narrow playhead subscriptions: both selectors return primitives, so the
  // card re-renders only when the playhead enters/leaves the clip or lands on
  // a keyframe — not on every playback frame.
  const isOverPlayhead = useEditor((s) => {
    const local = s.playhead - clip.timelineStart
    return local >= 0 && local <= durSec
  })
  const kfAtPlayhead = useEditor((s) => {
    const local = s.playhead - clip.timelineStart
    if (local < 0 || local > durSec || !clip.keyframes) return ''
    return KF_PROPS.filter((p) =>
      clip.keyframes?.[p]?.some((k) => Math.abs(k.t - local) < KF_TOL),
    ).join(',')
  })
  const color: ColorAdjust = clip.color ?? {
    brightness: 1,
    contrast: 1,
    saturation: 1,
    hue: 0,
    blur: 0,
  }

  function toggleKf(prop: KeyframeProp, currentValue: number): void {
    const clipLocal = useEditor.getState().playhead - clip.timelineStart
    if (clipLocal < 0 || clipLocal > durSec) return
    const list = clip.keyframes?.[prop]
    const existing = list?.find((k) => Math.abs(k.t - clipLocal) < KF_TOL)
    if (existing) {
      removeKeyframe(clip.id, prop, clipLocal)
    } else {
      setKeyframe(clip.id, prop, {
        t: clipLocal,
        value: currentValue,
        easing: 'linear',
      })
    }
  }

  function kf(prop: KeyframeProp, currentValue: number) {
    return {
      kfActive: kfAtPlayhead.split(',').includes(prop),
      kfDisabled: !isOverPlayhead,
      onKfToggle: () => toggleKf(prop, currentValue),
    }
  }

  return (
    <div className="rounded-lg border border-bd bg-surface2/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-bd">
        <span className="font-mono text-muted text-[10px]">
          #{clip.id.slice(-6)} · {durSec.toFixed(2)}s
        </span>
        <button
          onClick={onRemove}
          disabled={live}
          className="btn-ghost !py-0.5 !px-1.5 text-danger hover:text-danger-hover disabled:opacity-40 disabled:cursor-not-allowed"
          title={live ? LIVE_HINT : 'Delete (Del)'}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {live && (
        <div className="px-3 py-1.5 border-b border-bd text-[10px] text-danger bg-danger/10">
          {LIVE_HINT}
        </div>
      )}

      <div className="p-3 space-y-3">
        <Section label="Timing">
          <ScrubbableInput
            label="Start"
            value={clip.timelineStart}
            step={0.01}
            suffix="s"
            min={0}
            disabled={live}
            disabledHint={LIVE_HINT}
            {...scrub}
            onCommit={(v) => updateClip(clip.id, { timelineStart: Math.max(0, v) })}
          />
          <ScrubbableInput
            label="In"
            value={clip.sourceIn}
            step={0.01}
            suffix="s"
            min={0}
            disabled={live}
            disabledHint={LIVE_HINT}
            {...scrub}
            onCommit={(v) =>
              updateClip(clip.id, {
                sourceIn: Math.max(0, Math.min(clip.sourceOut - 0.01, v)),
              })
            }
          />
          <ScrubbableInput
            label="Out"
            value={clip.sourceOut}
            step={0.01}
            suffix="s"
            {...(maxOut !== undefined ? { max: maxOut } : {})}
            disabled={live}
            disabledHint={LIVE_HINT}
            {...scrub}
            onCommit={(v) => {
              const out = maxOut !== undefined ? Math.min(maxOut, v) : v
              updateClip(clip.id, {
                sourceOut: Math.max(clip.sourceIn + 0.01, out),
              })
            }}
          />
          <SliderField
            label="Speed"
            value={clip.speed}
            min={0.1}
            max={4}
            step={0.05}
            onInput={(v) => updateClip(clip.id, { speed: v })}
            onStart={beginInteraction}
            onEnd={endInteraction}
            format={(v) => `${v.toFixed(2)}x`}
            disabled={live}
          />
          {source?.kind === 'animation' && (
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={!!clip.loop}
                disabled={live}
                onChange={(e) => updateClip(clip.id, { loop: e.currentTarget.checked })}
              />
              Loop animation
            </label>
          )}
        </Section>

        {source?.kind === 'element' && <ElementSection source={source} />}
        {source?.kind === 'shape' && <ShapeSection source={source} />}

        <EffectsSection clip={clip} source={source} />

        <Section label="Audio">
          <SliderField
            label="Volume"
            value={clip.volume}
            min={0}
            max={1.5}
            step={0.01}
            onInput={(v) => updateClip(clip.id, { volume: v })}
            onStart={beginInteraction}
            onEnd={endInteraction}
            format={(v) => `${Math.round(v * 100)}%`}
            {...kf('volume', clip.volume)}
          />
        </Section>

        {source &&
          !live &&
          source.opfsPath &&
          (source.kind === 'video' || source.kind === 'audio') && (
            <>
              <TranscriptSection clip={clip} source={source} />
              <SilenceSection clip={clip} source={source} />
            </>
          )}

        <TransformSection clip={clip} source={source} kf={kf} />

        <Section label="Color">
          <SliderField
            label="Brightness"
            value={color.brightness}
            min={0}
            max={2}
            step={0.01}
            onInput={(v) => setColor(clip.id, { brightness: v })}
            onStart={beginInteraction}
            onEnd={endInteraction}
            format={(v) => v.toFixed(2)}
          />
          <SliderField
            label="Contrast"
            value={color.contrast}
            min={0}
            max={2}
            step={0.01}
            onInput={(v) => setColor(clip.id, { contrast: v })}
            onStart={beginInteraction}
            onEnd={endInteraction}
            format={(v) => v.toFixed(2)}
          />
          <SliderField
            label="Saturation"
            value={color.saturation}
            min={0}
            max={2}
            step={0.01}
            onInput={(v) => setColor(clip.id, { saturation: v })}
            onStart={beginInteraction}
            onEnd={endInteraction}
            format={(v) => v.toFixed(2)}
          />
          <SliderField
            label="Hue"
            value={color.hue}
            min={-180}
            max={180}
            step={1}
            onInput={(v) => setColor(clip.id, { hue: v })}
            onStart={beginInteraction}
            onEnd={endInteraction}
            format={(v) => `${v.toFixed(0)}°`}
          />
          <SliderField
            label="Blur"
            value={color.blur}
            min={0}
            max={20}
            step={0.5}
            onInput={(v) => setColor(clip.id, { blur: v })}
            onStart={beginInteraction}
            onEnd={endInteraction}
            format={(v) => `${v.toFixed(1)}px`}
          />
          {(color.brightness !== 1 ||
            color.contrast !== 1 ||
            color.saturation !== 1 ||
            color.hue !== 0 ||
            color.blur > 0) && (
            <button
              className="btn-ghost !py-1 !px-2 text-[10px] w-full justify-center"
              onClick={() =>
                setColor(clip.id, {
                  brightness: 1,
                  contrast: 1,
                  saturation: 1,
                  hue: 0,
                  blur: 0,
                })
              }
            >
              Reset color
            </button>
          )}
        </Section>

        {source?.kind === 'text' && source.text && (
          <TextSection
            source={source}
            onChange={(p) => updateTextStyle(source.id, p)}
            onBeginEdit={beginInteraction}
            onEndEdit={endInteraction}
          />
        )}
      </div>
    </div>
  )
}
