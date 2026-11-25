import { memo, useEffect, useRef, useState } from 'react'
import { useWindowListeners } from '../../lib/ui/useWindowListeners'
import { createPortal } from 'react-dom'
import { useEditor } from '../../lib/timeline/store'
import type { Clip, Track, Transition, TransitionKind } from '../../lib/timeline/types'
import { clipEndSec } from '../../lib/timeline/selectors'
// Gap threshold: show transition UI if the gap between clips is ≤ this value (seconds).
const TRANSITION_GAP_THRESHOLD = 0.5

const TRANSITION_LABELS: Record<TransitionKind, string> = {
  crossfade: 'Crossfade',
  'dip-black': 'Dip to Black',
  'dip-white': 'Dip to White',
  'wipe-left': 'Wipe Left',
  'wipe-right': 'Wipe Right',
  'wipe-up': 'Wipe Up',
  'wipe-down': 'Wipe Down',
  'slide-left': 'Slide Left',
  'slide-right': 'Slide Right',
}

function CrossfadeLayerImpl({
  track,
  clips,
  zoom,
}: {
  track: Track
  clips: Clip[]
  zoom: number
}) {
  const transitions = useEditor((s) => s.project.transitions)
  const addTransition = useEditor((s) => s.addTransition)
  const updateTransition = useEditor((s) => s.updateTransition)
  const removeTransition = useEditor((s) => s.removeTransition)

  if (track.locked || (track.kind !== 'video' && track.kind !== 'overlay')) return null

  const sorted = [...clips].sort((a, b) => a.timelineStart - b.timelineStart)
  const items: React.ReactNode[] = []

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a || !b) continue
    const aEnd = clipEndSec(a)
    const gap = b.timelineStart - aEnd // negative = overlap, 0 = adjacent, positive = gap

    if (gap > TRANSITION_GAP_THRESHOLD) continue // clips too far apart

    // Join point: midpoint between aEnd and bStart (same point when adjacent)
    const join = (aEnd + b.timelineStart) / 2
    const joinX = join * zoom

    // Max transition duration: half the shorter clip's duration × 2
    const aDur = (a.sourceOut - a.sourceIn) / (a.speed || 1)
    const bDur = (b.sourceOut - b.sourceIn) / (b.speed || 1)
    const maxDur = Math.min(aDur, bDur)

    const existing = transitions.find(
      (t) =>
        (t.fromClipId === a.id && t.toClipId === b.id) ||
        (t.fromClipId === b.id && t.toClipId === a.id),
    )

    if (existing) {
      const d = Math.min(existing.duration, maxDur)
      const halfW = Math.max(8, (d / 2) * zoom)
      items.push(
        <TransitionChip
          key={`tr-${a.id}-${b.id}`}
          fromClipId={a.id}
          toClipId={b.id}
          transition={existing}
          joinX={joinX}
          halfW={halfW}
          maxDur={maxDur}
          zoom={zoom}
          onRemove={() => removeTransition(existing.id)}
          onChange={(patch) => updateTransition(existing.id, patch)}
        />,
      )
    } else {
      // Show add-transition button centered at the join point
      items.push(
        <AddTransitionButton
          key={`add-${a.id}-${b.id}`}
          joinX={joinX}
          fromClipId={a.id}
          toClipId={b.id}
          maxDur={maxDur}
          onAdd={(kind, dur) =>
            addTransition({ fromClipId: a.id, toClipId: b.id, kind, duration: dur })
          }
        />,
      )
    }
  }

  return <>{items}</>
}

function AddTransitionButton({
  joinX,
  maxDur,
  onAdd,
}: {
  joinX: number
  fromClipId?: string
  toClipId?: string
  maxDur: number
  onAdd: (kind: TransitionKind, dur: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      const el = document.getElementById('add-transition-popover')
      if (
        !el?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [open])

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({ x: r.left + r.width / 2, y: r.top })
    }
    setOpen((v) => !v)
  }

  return (
    <div
      className="absolute top-0 bottom-0 flex items-center justify-center pointer-events-none z-10"
      style={{ left: joinX - 10, width: 20 }}
    >
      <button
        ref={btnRef}
        className="w-5 h-5 rounded-full border border-dashed border-accent/50 bg-surface text-accent-text/60 hover:text-accent-text hover:border-accent hover:bg-accent/10 flex items-center justify-center text-[11px] pointer-events-auto transition-colors"
        title="Add transition"
        onClick={handleClick}
      >
        ◆
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            id="add-transition-popover"
            className="fixed z-[200] w-44 bg-elevated border border-bd rounded-lg shadow-pop p-1.5"
            style={{
              left: pos.x,
              top: pos.y,
              transform: 'translateX(-50%) translateY(calc(-100% - 8px))',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="text-[10px] text-muted px-1 pb-1 font-semibold uppercase tracking-wider">
              Add Transition
            </p>
            {(Object.entries(TRANSITION_LABELS) as [TransitionKind, string][]).map(
              ([kind, label]) => (
                <button
                  key={kind}
                  className="w-full text-left px-2 py-1.5 text-[11px] rounded-md hover:bg-white/8 hover:text-fg text-fg/70 flex items-center gap-2"
                  onClick={(e) => {
                    e.stopPropagation()
                    const dur = Math.max(0.2, Math.min(1, maxDur * 0.5))
                    onAdd(kind, dur)
                    setOpen(false)
                  }}
                >
                  {kind === 'crossfade' ? '⇄' : kind.startsWith('dip') ? '●' : '▶'}{' '}
                  {label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

function TransitionChip({
  transition,
  joinX,
  halfW,
  maxDur,
  zoom,
  onRemove,
  onChange,
}: {
  fromClipId?: string
  toClipId?: string
  transition: Transition
  joinX: number
  halfW: number
  maxDur: number
  zoom: number
  onRemove: () => void
  onChange: (patch: { kind?: TransitionKind; duration?: number }) => void
}) {
  const win = useWindowListeners()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      const el = document.getElementById('transition-chip-popover')
      if (
        !el?.contains(e.target as Node) &&
        !barRef.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [open])

  const dur = Math.min(transition.duration, maxDur)

  function beginDurationDrag(e: React.MouseEvent) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startDur = dur
    useEditor.getState().beginInteraction()
    const move = (m: MouseEvent) => {
      const dx = m.clientX - startX
      onChange({ duration: Math.max(0.1, Math.min(maxDur, startDur + dx / zoom)) })
    }
    const up = () => {
      useEditor.getState().endInteraction()
      win.off('mousemove', move)
      win.off('mouseup', up)
    }
    win.on('mousemove', move)
    win.on('mouseup', up)
  }

  function handleBarClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open && barRef.current) {
      const r = barRef.current.getBoundingClientRect()
      setPos({ x: r.left + r.width / 2, y: r.top })
    }
    setOpen((v) => !v)
  }

  return (
    <div
      className="absolute top-2 bottom-2 z-10 pointer-events-none"
      style={{ left: joinX - halfW, width: halfW * 2 }}
    >
      <div
        ref={barRef}
        className="absolute inset-0 rounded border border-accent/60 bg-accent/20 backdrop-blur-[1px] cursor-ew-resize pointer-events-auto"
        title={`${TRANSITION_LABELS[transition.kind]} — ${dur.toFixed(2)}s · drag to resize · click to edit`}
        onMouseDown={beginDurationDrag}
        onClick={handleBarClick}
      >
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[9px] text-accent-text font-semibold truncate px-1 select-none">
            {transition.kind === 'crossfade' ? '⇄' : '▶'} {dur.toFixed(1)}s
          </span>
        </div>
      </div>

      {open &&
        pos &&
        createPortal(
          <div
            id="transition-chip-popover"
            className="fixed z-[200] w-48 bg-elevated border border-bd rounded-lg shadow-pop p-2"
            style={{
              left: pos.x,
              top: pos.y,
              transform: 'translateX(-50%) translateY(calc(-100% - 8px))',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="text-[10px] text-muted font-semibold uppercase tracking-wider mb-1.5">
              Transition
            </p>

            <label className="block text-[11px] text-fg/70 mb-0.5">Type</label>
            <select
              value={transition.kind}
              onChange={(e) => onChange({ kind: e.target.value as TransitionKind })}
              className="w-full bg-surface border border-bd rounded text-[11px] px-1.5 py-1 text-fg mb-2"
            >
              {(Object.entries(TRANSITION_LABELS) as [TransitionKind, string][]).map(
                ([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ),
              )}
            </select>

            <label className="block text-[11px] text-fg/70 mb-0.5">
              Duration: {dur.toFixed(2)}s
            </label>
            <input
              type="range"
              min={0.1}
              max={maxDur}
              step={0.05}
              value={dur}
              onChange={(e) => onChange({ duration: parseFloat(e.target.value) })}
              className="w-full accent-accent mb-2"
            />

            <button
              className="w-full text-[11px] text-danger/80 hover:text-danger py-1 rounded hover:bg-danger/10"
              onClick={() => {
                onRemove()
                setOpen(false)
              }}
            >
              Remove transition
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}

/** Transition chips / add-buttons between adjacent clips on a track. */
export const CrossfadeLayer = memo(CrossfadeLayerImpl)
