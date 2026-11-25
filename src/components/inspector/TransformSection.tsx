import { useMemo } from 'react'
import { Link2, Unlink2 } from 'lucide-react'
import { ScrubbableInput } from '../ui/ScrubbableInput'
import { useEditor } from '../../lib/timeline/store'
import type {
  BlendMode,
  Clip,
  ClipCrop,
  KeyframeProp,
  MediaSource,
} from '../../lib/timeline/types'
import { BLEND_MODES } from '../../lib/timeline/types'
import { visualBox } from '../../lib/layout/geometry'
import { canvasTextMeasurer } from '../../lib/layout/textMeasure'
import { setClipAnchor, setClipCrop, setClipSize } from '../../lib/layout/actions'
import { MAX_CROP, anchorOf, isCroppableKind } from '../../lib/layout/placement'
import { isAspectLocked, scaleFieldPatch } from '../../lib/layout/transformOps'
import { KfRow, Section, SliderField } from './fields'
import { PositionPresets, TransformControls } from '../layout/TransformControls'

type KfProps = (
  prop: KeyframeProp,
  value: number,
) => { kfActive: boolean; kfDisabled: boolean; onKfToggle: () => void }

const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  'color-dodge': 'Color dodge',
  'color-burn': 'Color burn',
  'soft-light': 'Soft light',
  'hard-light': 'Hard light',
  difference: 'Difference',
}

const CROP_SIDES: { key: keyof ClipCrop; label: string; opposite: keyof ClipCrop }[] = [
  { key: 'left', label: 'Left', opposite: 'right' },
  { key: 'right', label: 'Right', opposite: 'left' },
  { key: 'top', label: 'Top', opposite: 'bottom' },
  { key: 'bottom', label: 'Bottom', opposite: 'top' },
]

/**
 * Inspector Transform: position, size in px (with the aspect lock), scale,
 * rotation, opacity, anchor point, flip / fit / fill / reset, position
 * presets and (pictures only) crop.
 */
export function TransformSection({
  clip,
  source,
  kf,
}: {
  clip: Clip
  source: MediaSource | undefined
  kf: KfProps
}) {
  const setTransform = useEditor((s) => s.setTransform)
  const setBlendMode = useEditor((s) => s.setBlendMode)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const endInteraction = useEditor((s) => s.endInteraction)
  const width = useEditor((s) => s.project.width)
  const height = useEditor((s) => s.project.height)
  const trackKind = useEditor(
    (s) => s.project.tracks.find((t) => t.id === clip.trackId)?.kind,
  )
  const scrub = { onScrubStart: beginInteraction, onScrubEnd: endInteraction }
  const tf = clip.transform
  // Selection box from the stored transform (size fields, anchor, crop).
  const box = useMemo(
    () =>
      (trackKind === 'video' || trackKind === 'overlay') && source
        ? visualBox(
            { width, height },
            { kind: trackKind },
            source,
            tf,
            canvasTextMeasurer,
            clip.crop,
          )
        : null,
    [source, width, height, trackKind, tf, clip.crop],
  )
  const locked = isAspectLocked(tf)
  const anchor = anchorOf(tf)
  const croppable = !!source && isCroppableKind(source.kind)
  const crop: ClipCrop = clip.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const ids = [clip.id]

  return (
    <Section label="Transform">
      <div className="grid grid-cols-2 gap-2">
        <KfRow {...kf('x', tf.x)}>
          <ScrubbableInput
            label="X"
            value={tf.x}
            step={1}
            {...scrub}
            onCommit={(v) => setTransform(clip.id, { x: v })}
          />
        </KfRow>
        <KfRow {...kf('y', tf.y)}>
          <ScrubbableInput
            label="Y"
            value={tf.y}
            step={1}
            {...scrub}
            onCommit={(v) => setTransform(clip.id, { y: v })}
          />
        </KfRow>
      </div>
      {box && (
        <div className="flex items-center gap-1" data-transform-size>
          <div className="flex-1 min-w-0">
            <ScrubbableInput
              label="W"
              value={Math.round(box.width * 10) / 10}
              step={1}
              suffix="px"
              {...scrub}
              onCommit={(v) => setClipSize(clip.id, { width: v })}
            />
          </div>
          <button
            type="button"
            className={
              'w-6 h-6 shrink-0 inline-flex items-center justify-center rounded hover:bg-white/5 ' +
              (locked ? 'text-accent-text' : 'text-muted hover:text-fg')
            }
            aria-pressed={locked}
            aria-label="Lock aspect ratio"
            title={
              locked
                ? 'Aspect ratio locked: width and height change together'
                : 'Aspect ratio unlocked'
            }
            data-transform-action="lock-aspect"
            onClick={() => setTransform(clip.id, { lockAspect: !locked })}
          >
            {locked ? <Link2 size={13} /> : <Unlink2 size={13} />}
          </button>
          <div className="flex-1 min-w-0">
            <ScrubbableInput
              label="H"
              value={Math.round(box.height * 10) / 10}
              step={1}
              suffix="px"
              {...scrub}
              onCommit={(v) => setClipSize(clip.id, { height: v })}
            />
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <KfRow {...kf('scaleX', tf.scaleX)}>
          <ScrubbableInput
            label="Scale X"
            value={tf.scaleX}
            step={0.01}
            {...scrub}
            onCommit={(v) => setTransform(clip.id, scaleFieldPatch(tf, 'scaleX', v))}
          />
        </KfRow>
        <KfRow {...kf('scaleY', tf.scaleY)}>
          <ScrubbableInput
            label="Scale Y"
            value={tf.scaleY}
            step={0.01}
            {...scrub}
            onCommit={(v) => setTransform(clip.id, scaleFieldPatch(tf, 'scaleY', v))}
          />
        </KfRow>
      </div>
      <SliderField
        label="Rotation"
        value={tf.rotation}
        min={-180}
        max={180}
        step={1}
        onInput={(v) => setTransform(clip.id, { rotation: v })}
        onStart={beginInteraction}
        onEnd={endInteraction}
        format={(v) => `${v.toFixed(0)}°`}
        {...kf('rotation', tf.rotation)}
      />
      <SliderField
        label="Opacity"
        value={tf.opacity}
        min={0}
        max={1}
        step={0.01}
        onInput={(v) => setTransform(clip.id, { opacity: v })}
        onStart={beginInteraction}
        onEnd={endInteraction}
        format={(v) => `${Math.round(v * 100)}%`}
        {...kf('opacity', tf.opacity)}
      />
      {box && (
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted text-[11px]">Blend mode</span>
          <select
            value={clip.blendMode ?? 'normal'}
            data-blend-mode
            disabled={!!clip.isLive}
            onChange={(e) =>
              setBlendMode([clip.id], e.currentTarget.value as BlendMode)
            }
            className="bg-surface border border-bd rounded px-1.5 py-1 text-[11px] focus:border-accent focus:outline-none"
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>
                {BLEND_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
      )}
      {box && (
        <>
          <div className="grid grid-cols-2 gap-2" data-transform-anchor>
            <ScrubbableInput
              label="Anchor X"
              value={Math.round(anchor.ax * 1000) / 10}
              step={1}
              min={0}
              max={100}
              suffix="%"
              {...scrub}
              onCommit={(v) => setClipAnchor(clip.id, v / 100, anchor.ay)}
            />
            <ScrubbableInput
              label="Anchor Y"
              value={Math.round(anchor.ay * 1000) / 10}
              step={1}
              min={0}
              max={100}
              suffix="%"
              {...scrub}
              onCommit={(v) => setClipAnchor(clip.id, anchor.ax, v / 100)}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <TransformControls ids={ids} />
            <PositionPresets ids={ids} />
          </div>
        </>
      )}
      {box && croppable && (
        <div className="space-y-1.5 pt-1" data-transform-crop>
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted font-semibold">
            Crop
          </div>
          <div className="grid grid-cols-2 gap-2">
            {CROP_SIDES.map(({ key, label, opposite }) => (
              <ScrubbableInput
                key={key}
                label={label}
                value={Math.round(crop[key] * 1000) / 10}
                step={0.5}
                min={0}
                max={MAX_CROP * 100}
                suffix="%"
                {...scrub}
                onCommit={(v) => {
                  // The edited side gives way to the opposite one (<= 95 %).
                  const value = Math.min(
                    Math.max(0, v / 100),
                    MAX_CROP - crop[opposite],
                  )
                  setClipCrop(clip.id, { ...crop, [key]: value })
                }}
              />
            ))}
          </div>
          {clip.crop && (
            <button
              type="button"
              className="btn-ghost !py-1 !px-2 text-[10px] w-full justify-center"
              data-transform-action="reset-crop"
              onClick={() => setClipCrop(clip.id, null)}
            >
              Reset crop
            </button>
          )}
        </div>
      )}
    </Section>
  )
}
