import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWindowListeners } from '../../lib/ui/useWindowListeners'
import {
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Volume2,
  VolumeX,
  GripVertical,
  Trash2,
  Scissors,
  Copy,
  ArrowLeftToLine,
  Library,
  Monitor,
  Camera,
  Mic,
  Download,
  Link2,
  Combine,
  Unlink2,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useEditor } from '../../lib/timeline/store'
import type { Clip, ID, MediaSource, Track, TrackKind } from '../../lib/timeline/types'
import { usePoster, useThumbnails, useWaveform } from '../../lib/media/hooks'
import { clipDurationSec, clipEndSec, snapToEdges } from '../../lib/timeline/selectors'
import { TimelineRuler } from './TimelineRuler'
import { CrossfadeLayer } from './Transitions'
import { EffectBars } from './EffectBars'
import { ELEMENT_DRAG_MIME } from '../../lib/elements'
import { useToast } from '../ui/Toast'
import { useMergeClips } from '../MergeProgress'
import { useMergeJob } from '../../lib/edit/mergeClips'
import { isTextEntryTarget } from '../../lib/ui/keyTargets'
import { isSourceCompatible } from '../../lib/timeline/compat'
import { installClipboardHandlers } from '../../lib/timeline/clipboardEvents'
import { PASTE_ATTRIBUTES_EVENT, arrangeSelection } from '../../lib/layout/actions'
import { SHAPE_DRAG_MIME, isShapeType } from '../../lib/shapes'
/** Pixel-distance threshold within which snapping kicks in. */
const SNAP_PX = 8
/** Pointer travel (px) before a clip mousedown turns into a drag. */
const DRAG_THRESHOLD_PX = 3

const LIVE_HINT = 'Recording — stop to edit'

type ToastApi = ReturnType<typeof useToast>

/** Whether a clip dragged off a `fromKind` track may land on `target`. */
function canDropOnTrack(
  target: Track,
  srcKind: MediaSource['kind'] | undefined,
  fromKind: TrackKind,
): boolean {
  if (target.locked) return false
  if (srcKind) return isSourceCompatible(target.kind, srcKind)
  // Unknown source: fall back to video/overlay ↔ video/overlay, audio ↔ audio.
  const group = (k: TrackKind) => (k === 'audio' ? 'a' : k === 'text' ? 't' : 'v')
  return group(target.kind) === group(fromKind)
}

/** Identity of the undo history right now (top entry + redo depth). */
function historyMarker(): { top: unknown; future: number } {
  const st = useEditor.getState()
  return { top: st.past[st.past.length - 1], future: st.future.length }
}

/**
 * Toast "Undo" handler: only undo if nothing has been added to / undone from
 * the history since `marker` — otherwise a plain undo() would revert whatever
 * the user did after the toast appeared.
 */
function undoIfUnchanged(
  marker: { top: unknown; future: number },
  toast: ToastApi,
): void {
  const now = historyMarker()
  if (now.top === marker.top && now.future === marker.future) {
    useEditor.getState().undo()
  } else {
    toast.info('Nothing undone', 'The timeline changed since — use Ctrl+Z instead.')
  }
}

/** Delete (or ripple-delete) clips as ONE undo step, with a guarded Undo toast. */
function deleteClips(ids: ID[], ripple: boolean, toast: ToastApi): void {
  const st = useEditor.getState()
  const live = new Set(st.project.clips.filter((c) => c.isLive).map((c) => c.id))
  const targets = ids.filter((id) => !live.has(id))
  if (targets.length < ids.length) {
    toast.info(LIVE_HINT, 'Clips that are still recording can’t be deleted.')
  }
  if (targets.length === 0) return
  st.beginInteraction()
  try {
    for (const id of targets) {
      if (ripple) st.rippleDeleteClip(id)
      else st.removeClip(id)
    }
  } finally {
    st.endInteraction()
  }
  const marker = historyMarker()
  const n = targets.length
  const verb = ripple ? 'ripple-deleted' : 'deleted'
  toast.withAction(n === 1 ? `Clip ${verb}` : `${n} clips ${verb}`, {
    label: 'Undo',
    onClick: () => undoIfUnchanged(marker, toast),
  })
}

function warnLiveSplit(toast: ToastApi): void {
  toast.info(
    'Can’t split while recording',
    'Clips that are still recording can be split after you stop.',
  )
}

/** Keyboard focus is in a text field / editable element. */
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
  )
}

/** Bare keys the focused preview stage handles itself (besides the arrows). */
const PREVIEW_STAGE_KEYS = new Set(['KeyC', 'Enter', 'NumpadEnter'])

/** The event comes from inside the preview stage (it owns the arrow keys). */
function isInPreviewStage(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('[data-preview-stage]') !== null
}

/** A modal (help, command palette, export, record setup…) is open. */
function isModalOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

/** Handle a library source dropped onto a track at `dropTime`. */
function dropSourceOnTrack(trackId: ID, sourceId: ID, dropTime: number): void {
  const st = useEditor.getState()
  const project = st.project
  const t = project.tracks.find((x) => x.id === trackId)
  const src = project.sources.find((s) => s.id === sourceId)
  if (!t || !src) return
  if (!isSourceCompatible(t.kind, src.kind)) return
  const dur = src.duration > 0 ? src.duration : 5 // still images default to 5s
  const start = Math.max(0, dropTime)
  const end = start + dur

  // Premiere-style smart routing: if the drop overlaps an
  // existing clip on the target track, place the new clip on
  // an overlay track ABOVE it (creating one if needed) so
  // both are visible simultaneously. Without this, the
  // renderer only shows one clip per track at a time and
  // the newly-dropped object appears to be invisible.
  const targetKind = t.kind
  let targetTrackId = t.id
  const hasOverlap = project.clips.some(
    (c) => c.trackId === t.id && start < clipEndSec(c) && end > c.timelineStart,
  )
  if (hasOverlap && targetKind !== 'audio') {
    // With the renderer reversed, tracks earlier in the array
    // (visually ABOVE the target in the UI) paint on top.
    const overlayKind = 'overlay' as const
    const targetIdx = project.tracks.findIndex((x) => x.id === t.id)
    const above = project.tracks.slice(0, targetIdx)
    const free = above.find((tr) => {
      if (tr.kind !== overlayKind && tr.kind !== 'video') return false
      if (tr.locked) return false
      if (!isSourceCompatible(tr.kind, src.kind)) return false
      return !project.clips.some(
        (c) => c.trackId === tr.id && start < clipEndSec(c) && end > c.timelineStart,
      )
    })
    if (free) {
      targetTrackId = free.id
    } else {
      targetTrackId = st.addTrack(overlayKind, undefined, {
        beforeTrackId: t.id,
      })
    }
  }

  st.addClip({
    trackId: targetTrackId,
    sourceId: src.id,
    timelineStart: start,
    sourceIn: 0,
    sourceOut: dur,
    speed: 1,
    volume: src.kind === 'animation' ? 0 : 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
    // Animations that loop by themselves keep looping when stretched.
    ...(src.kind === 'animation' && src.animation?.loop ? { loop: true } : {}),
  })
}

const MIN_HEADER_W = 120
const MAX_HEADER_W = 320
const DEFAULT_HEADER_W = 180
const RULER_H = 28

type DragMode = 'move' | 'trim-start' | 'trim-end'

type ClipMouseDown = (e: React.MouseEvent, clipId: ID, mode: DragMode) => void

export function Timeline() {
  const win = useWindowListeners()
  // Deliberately NOT subscribed to `playhead`: that changes every playback
  // frame. The playhead line/head are separate components that subscribe
  // themselves, so the track rows only re-render on real edits.
  const tracks = useEditor((s) => s.project.tracks)
  const markers = useEditor((s) => s.project.markers)
  const duration = useEditor((s) => s.project.duration)
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setZoom = useEditor((s) => s.setZoom)
  const setSelection = useEditor((s) => s.setSelection)
  const toast = useToast()

  const scrollRef = useRef<HTMLDivElement>(null)
  const tracksRef = useRef<HTMLDivElement>(null)
  const headerListRef = useRef<HTMLDivElement>(null)
  const [headerW, setHeaderW] = useState(DEFAULT_HEADER_W)
  const [razorMode, setRazorMode] = useState(false)
  const razorRef = useRef(razorMode)
  useEffect(() => {
    razorRef.current = razorMode
  }, [razorMode])
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{
    x0: number
    y0: number
    x1: number
    y1: number
  } | null>(null)

  // Sync vertical scroll: header list mirrors the content column's scrollTop.
  // This keeps track headers perfectly aligned with their track rows at all times.
  useEffect(() => {
    const content = scrollRef.current
    const header = headerListRef.current
    if (!content || !header) return
    let syncingFromContent = false
    let syncingFromHeader = false
    const onContentScroll = () => {
      if (syncingFromHeader) return
      syncingFromContent = true
      header.scrollTop = content.scrollTop
      syncingFromContent = false
    }
    const onHeaderScroll = () => {
      if (syncingFromContent) return
      syncingFromHeader = true
      content.scrollTop = header.scrollTop
      syncingFromHeader = false
    }
    content.addEventListener('scroll', onContentScroll, { passive: true })
    header.addEventListener('scroll', onHeaderScroll, { passive: true })
    return () => {
      content.removeEventListener('scroll', onContentScroll)
      header.removeEventListener('scroll', onHeaderScroll)
    }
  }, [])

  // Horizontal viewport (scrollLeft..scrollLeft+clientWidth) in px, used to
  // virtualize clip rendering. Updated on scroll / resize / zoom.
  const [viewport, setViewport] = useState<{ left: number; right: number }>({
    left: 0,
    right: 2000,
  })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () =>
      setViewport((v) =>
        v.left === el.scrollLeft && v.right === el.scrollLeft + el.clientWidth
          ? v
          : { left: el.scrollLeft, right: el.scrollLeft + el.clientWidth },
      )
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])

  const totalSec = useMemo(() => Math.max(duration + 5, 30), [duration])
  const contentWidth = totalSec * zoom

  /** Fit the whole project into the visible width (menu View → Fit, button). */
  const fitToView = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dur = useEditor.getState().project.duration
    const w = Math.max(100, el.clientWidth - 16)
    // setZoom clamps to [10, 800] px/s; very long projects fit as far as allowed.
    setZoom(w / (dur > 0 ? dur : 30))
    el.scrollLeft = 0
  }, [setZoom])

  useEffect(() => {
    window.addEventListener('ir:zoom-fit', fitToView)
    return () => window.removeEventListener('ir:zoom-fit', fitToView)
  }, [fitToView])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Plain wheel scrolls natively (vertical tracks; trackpads also pan
      // horizontally). Shift+wheel pans horizontally. Ctrl/Cmd+wheel — and
      // trackpad pinch, which arrives as a ctrlKey wheel — zooms at the cursor.
      if (!e.ctrlKey && !e.metaKey) {
        if (e.shiftKey && e.deltaX === 0 && e.deltaY !== 0) {
          e.preventDefault()
          el.scrollLeft += e.deltaY
        }
        return
      }
      if (e.deltaY === 0) return
      e.preventDefault()
      const cur = useEditor.getState().zoom
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left + el.scrollLeft
      const timeAtCursor = cursorX / cur
      // Pinch deltas are small and continuous; wheel notches are ~100.
      const factor = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.0015)
      const next = Math.max(10, Math.min(800, cur * factor))
      setZoom(next)
      // Keep the time under the cursor anchored after zoom.
      requestAnimationFrame(() => {
        const newCursorX = timeAtCursor * next
        el.scrollLeft = Math.max(0, newCursorX - (e.clientX - rect.left))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoom])

  // Safety net — if the user releases the mouse outside the timeline
  // (e.g. drags off-window and releases), endInteraction may never fire.
  // This global listener closes any open interaction so undo history never
  // stays permanently "open" and merges unrelated operations together.
  // Deferred to the next task so every drag's own pointerup/mouseup handler
  // finishes first — closing early would split one drag into two undo steps.
  useEffect(() => {
    let timer: number | null = null
    const onPointerUp = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        const st = useEditor.getState()
        if (st._interactionDepth > 0) st.resetInteraction()
      }, 0)
    }
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  // Editing shortcuts (S, Delete, Backspace, Ctrl+Z, Ctrl+Shift+Z).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      // Modals own the keyboard while open.
      if (isModalOpen()) return
      const mod = e.ctrlKey || e.metaKey
      // Undo / redo work everywhere except inside text fields (their own undo).
      if (mod && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
        if (isTextEntryTarget(e.target)) return
        e.preventDefault()
        if (e.code === 'KeyY' || e.shiftKey) useEditor.getState().redo()
        else useEditor.getState().undo()
        return
      }
      // Layer order: Ctrl+] / Ctrl+[ (Shift = to front / back). Also from
      // the focused preview stage (the event bubbles here).
      if (mod && !e.altKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        if (isTextEntryTarget(e.target)) return
        e.preventDefault()
        const up = e.code === 'BracketRight'
        arrangeSelection(
          up ? (e.shiftKey ? 'front' : 'forward') : e.shiftKey ? 'back' : 'backward',
        )
        return
      }
      // Paste attributes… (Ctrl+Alt+V).
      if (mod && e.altKey && !e.shiftKey && e.code === 'KeyV') {
        if (isTextEntryTarget(e.target)) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent(PASTE_ATTRIBUTES_EVENT))
        return
      }
      if (isEditableTarget(e.target)) return
      // Let Space/Enter activate a focused button normally.
      if (
        (e.target as HTMLElement | null)?.tagName === 'BUTTON' &&
        (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter')
      )
        return
      // Everything below is a bare-key shortcut (Shift allowed where noted).
      // With Ctrl/Cmd/Alt held the key belongs to the menu / browser
      // (e.g. Ctrl+S = Save, not Split).
      if (mod || e.altKey) return
      // Keys the focused preview stage owns (C = crop mode, Enter = finish).
      if (isInPreviewStage(e.target) && PREVIEW_STAGE_KEYS.has(e.code)) return

      if (e.code === 'KeyR' && !e.shiftKey) {
        e.preventDefault()
        setRazorMode((v) => !v)
        return
      }
      if (e.code === 'Escape') {
        setRazorMode(false)
        return
      }
      const st = useEditor.getState()
      if (e.code === 'KeyS' && !e.shiftKey) {
        e.preventDefault()
        const sel = st.selection
        // Split all selected clips, or all clips if nothing is selected
        const hitsLive = st.project.clips.some(
          (c) =>
            c.isLive &&
            (sel.length === 0 || sel.includes(c.id)) &&
            st.playhead > c.timelineStart,
        )
        if (hitsLive) warnLiveSplit(toast)
        if (sel.length > 0) st.splitAt(st.playhead, undefined, sel)
        else st.splitAt(st.playhead)
      } else if (e.code === 'KeyM' && !e.shiftKey) {
        e.preventDefault()
        st.addMarker({ time: st.playhead, label: '' })
      } else if (e.code === 'Space') {
        e.preventDefault()
        st.setPlaying(!st.playing)
      } else if (e.code === 'KeyK') {
        e.preventDefault()
        st.setPlaying(false)
      } else if (e.code === 'KeyL') {
        e.preventDefault()
        st.setPlaying(true)
      } else if (e.code === 'KeyJ') {
        e.preventDefault()
        st.setPlaying(false)
        st.setPlayhead(Math.max(0, st.playhead - 1))
      } else if (e.code === 'Home') {
        e.preventDefault()
        st.setPlayhead(0)
      } else if (e.code === 'End') {
        e.preventDefault()
        st.setPlayhead(st.project.duration)
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        // With the preview focused, arrows nudge the selected objects there.
        if (isInPreviewStage(e.target)) return
        e.preventDefault()
        const fps = st.project.fps || 30
        const step = e.shiftKey ? 10 / fps : 1 / fps
        const dir = e.code === 'ArrowLeft' ? -1 : 1
        st.setPlayhead(Math.max(0, st.playhead + dir * step))
      } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        // [ set in-point at playhead for selected clip(s);
        // ] set out-point. Adjusts sourceIn/sourceOut.
        e.preventDefault()
        const t = st.playhead
        let skippedLive = false
        for (const id of st.selection) {
          const c = st.project.clips.find((x) => x.id === id)
          if (!c) continue
          if (c.isLive) {
            skippedLive = true
            continue
          }
          const end = clipEndSec(c)
          if (t <= c.timelineStart || t >= end) continue
          if (e.code === 'BracketLeft') {
            // delta positive → trim later
            st.trimClip(id, 'start', t - c.timelineStart)
          } else {
            st.trimClip(id, 'end', t - end)
          }
        }
        if (skippedLive) toast.info(LIVE_HINT)
      } else if (e.code === 'KeyF' && !e.shiftKey) {
        const sel = st.selection
        if (sel.length) {
          e.preventDefault()
          const clip = st.project.clips.find((c) => c.id === sel[0])
          if (clip?.sourceId) st.revealSource(clip.sourceId)
        }
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        const sel = st.selection
        if (sel.length) {
          e.preventDefault()
          deleteClips([...sel], e.shiftKey, toast)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toast])

  // Copy / cut / paste of clips (keyboard and the Edit menu roles).
  useEffect(
    () =>
      installClipboardHandlers({
        onPaste: ({ ids, skipped }) => {
          if (skipped > 0)
            toast.info(
              `${String(skipped)} clip${skipped === 1 ? '' : 's'} not pasted`,
              'Their media isn’t in this project.',
            )
          else if (ids.length === 0) toast.info('Nothing pasted')
        },
        onCut: (n) => {
          const marker = historyMarker()
          toast.withAction(n === 1 ? 'Clip cut' : `${String(n)} clips cut`, {
            label: 'Undo',
            onClick: () => undoIfUnchanged(marker, toast),
          })
        },
      }),
    [toast],
  )

  function onRulerMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    // The ruler strip spans the full content width and scrolls with it, so
    // its bounding rect already accounts for scrollLeft.
    const ruler = e.currentTarget
    const toTime = (clientX: number) => {
      const rect = ruler.getBoundingClientRect()
      // Current zoom, not the one at mousedown (Ctrl+wheel while scrubbing).
      const { project, zoom: z } = useEditor.getState()
      return Math.max(0, Math.min(project.duration, (clientX - rect.left) / z))
    }
    setPlayhead(toTime(e.clientX))
    const onMove = (m: MouseEvent) => setPlayhead(toTime(m.clientX))
    const onUp = () => {
      win.off('mousemove', onMove)
      win.off('mouseup', onUp)
    }
    win.on('mousemove', onMove)
    win.on('mouseup', onUp)
  }

  /** Track index under a client Y coordinate (clamped to the track list). */
  function trackIndexAtY(clientY: number): number {
    const el = tracksRef.current
    const ts = useEditor.getState().project.tracks
    if (!el || ts.length === 0) return -1
    const y = clientY - el.getBoundingClientRect().top
    let off = 0
    for (let i = 0; i < ts.length; i++) {
      off += ts[i]!.height
      if (y < off) return i
    }
    return ts.length - 1
  }

  // Latest-closure ref so the stable onClipMouseDown below never goes stale.
  const beginClipDragRef = useRef<
    (e: React.MouseEvent, clip: Clip, mode: DragMode, collapseOnClick: boolean) => void
  >(() => {})

  function beginClipDrag(
    e: React.MouseEvent,
    grabbed: Clip,
    mode: DragMode,
    collapseOnClick: boolean,
  ): void {
    const st0 = useEditor.getState()
    const project = st0.project
    const z = st0.zoom
    const tIdx = (trackId: ID) => project.tracks.findIndex((t) => t.id === trackId)
    const srcKind = (c: Clip) => project.sources.find((s) => s.id === c.sourceId)?.kind

    // Clips that move with this drag: every selected, non-live clip on an
    // unlocked track. One representative per link group (the store moves the
    // rest of the group in time), otherwise linked clips would move twice.
    const movers: Clip[] = [grabbed]
    if (mode === 'move') {
      const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
      const groups = new Set<ID>()
      if (grabbed.linkGroup) groups.add(grabbed.linkGroup)
      for (const id of st0.selection) {
        if (id === grabbed.id) continue
        const c = project.clips.find((x) => x.id === id)
        if (!c || c.isLive || locked.has(c.trackId)) continue
        if (c.linkGroup) {
          if (groups.has(c.linkGroup)) continue
          groups.add(c.linkGroup)
        }
        movers.push(c)
      }
    }
    const moverIds = new Set(movers.map((c) => c.id))
    const moverGroups = new Set(
      movers.map((c) => c.linkGroup).filter((g): g is ID => !!g),
    )
    const affected = project.clips.filter(
      (c) => moverIds.has(c.id) || (!!c.linkGroup && moverGroups.has(c.linkGroup)),
    )
    const affectedIds = new Set(affected.map((c) => c.id))
    // No clip in the drag may go before 0 — clamp the shared delta once.
    const minStart = Math.min(...affected.map((c) => c.timelineStart))
    const startOf = new Map(movers.map((c) => [c.id, c.timelineStart]))
    const origTrack = new Map(movers.map((c) => [c.id, tIdx(c.trackId)]))

    const speed = grabbed.speed || 1
    const grabbedStart = grabbed.timelineStart
    const grabbedEnd = clipEndSec(grabbed)
    const grabbedDur = clipDurationSec(grabbed)
    const src = project.sources.find((s) => s.id === grabbed.sourceId)
    // Only real media bounds the trim-out; stills / text can stretch freely.
    const maxSrcOut =
      src &&
      (src.kind === 'video' ||
        src.kind === 'audio' ||
        (src.kind === 'animation' && !grabbed.loop)) &&
      src.duration > 0
        ? src.duration
        : Infinity

    // Snap candidates: other clips' edges, the playhead, origin, markers.
    const candidates: number[] = [0, st0.playhead]
    for (const m of project.markers ?? []) candidates.push(m.time)
    for (const c of project.clips) {
      if (mode === 'move' ? affectedIds.has(c.id) : c.id === grabbed.id) continue
      candidates.push(c.timelineStart)
      candidates.push(clipEndSec(c))
    }

    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    let started = false
    let appliedTrackDelta = 0

    const onMoveEv = (m: MouseEvent) => {
      const dx = m.clientX - startX
      if (
        !moved &&
        Math.abs(dx) < DRAG_THRESHOLD_PX &&
        Math.abs(m.clientY - startY) < DRAG_THRESHOLD_PX
      )
        return
      moved = true
      if (!started) {
        // One drag = one undo step (begun lazily so a plain click adds none).
        useEditor.getState().beginInteraction()
        started = true
      }
      const threshold = SNAP_PX / z
      let delta = dx / z
      let snapAt: number | null = null
      const st = useEditor.getState()
      const current = (id: ID) => st.project.clips.find((c) => c.id === id)

      // Every move derives the ABSOLUTE target from the drag-start position
      // and sends the store only the difference from where the clip is now,
      // so store-side clamping can never accumulate into cursor drift.
      if (mode === 'move') {
        if (!m.altKey) {
          const s0 = grabbedStart + delta
          const sSnap = snapToEdges(s0, candidates, threshold)
          if (sSnap !== s0) {
            delta = sSnap - grabbedStart
            snapAt = sSnap
          } else {
            const e0 = s0 + grabbedDur
            const eSnap = snapToEdges(e0, candidates, threshold)
            if (eSnap !== e0) {
              delta = eSnap - grabbedDur - grabbedStart
              snapAt = eSnap
            }
          }
        }
        if (delta < -minStart) {
          delta = -minStart
          snapAt = null
        }

        // Vertical: follow the pointer's track, but only onto compatible,
        // unlocked tracks (for every moving clip); otherwise stay put.
        let trackDelta = appliedTrackDelta
        const pointerIdx = trackIndexAtY(m.clientY)
        const grabbedOrig = origTrack.get(grabbed.id) ?? -1
        if (pointerIdx >= 0 && grabbedOrig >= 0) {
          const want = pointerIdx - grabbedOrig
          if (want !== appliedTrackDelta) {
            const ok = movers.every((c) => {
              const from = project.tracks[origTrack.get(c.id) ?? -1]
              const target = project.tracks[(origTrack.get(c.id) ?? -1) + want]
              if (!from || !target) return false
              return want === 0 || canDropOnTrack(target, srcKind(c), from.kind)
            })
            if (ok) trackDelta = want
          }
        }
        appliedTrackDelta = trackDelta

        for (const mv of movers) {
          const c = current(mv.id)
          if (!c) continue
          const dt = (startOf.get(mv.id) ?? c.timelineStart) + delta - c.timelineStart
          const wantIdx = (origTrack.get(mv.id) ?? 0) + trackDelta
          const dTrack =
            wantIdx - st.project.tracks.findIndex((t) => t.id === c.trackId)
          if (Math.abs(dt) > 1e-9 || dTrack !== 0) st.moveClip(mv.id, dt, dTrack)
        }
      } else if (mode === 'trim-start') {
        let target = grabbedStart + delta
        if (!m.altKey) {
          const snapped = snapToEdges(target, candidates, threshold)
          if (snapped !== target) {
            target = snapped
            snapAt = snapped
          }
        }
        // sourceIn can't go below 0, timelineStart can't go below 0, and the
        // clip keeps a minimum length.
        const lo = Math.max(0, grabbedStart - grabbed.sourceIn / speed)
        const hi = grabbedEnd - 0.01 / speed
        const clamped = Math.max(lo, Math.min(hi, target))
        if (clamped !== target) snapAt = null
        const c = current(grabbed.id)
        if (c) {
          const d = clamped - c.timelineStart
          if (Math.abs(d) > 1e-9) st.trimClip(grabbed.id, 'start', d)
        }
      } else {
        let target = grabbedEnd + delta
        if (!m.altKey) {
          const snapped = snapToEdges(target, candidates, threshold)
          if (snapped !== target) {
            target = snapped
            snapAt = snapped
          }
        }
        const lo = grabbedStart + 0.01 / speed
        const hi = grabbedStart + (maxSrcOut - grabbed.sourceIn) / speed
        const clamped = Math.max(lo, Math.min(hi, target))
        if (clamped !== target) snapAt = null
        const c = current(grabbed.id)
        if (c) {
          const d = clamped - clipEndSec(c)
          if (Math.abs(d) > 1e-9) st.trimClip(grabbed.id, 'end', d)
        }
      }
      setSnapLine(snapAt)
    }
    const onUp = () => {
      setSnapLine(null)
      if (started) useEditor.getState().endInteraction()
      // Plain click on an already-selected clip collapses the selection to it.
      if (!moved && collapseOnClick) useEditor.getState().setSelection([grabbed.id])
      win.off('mousemove', onMoveEv)
      win.off('mouseup', onUp)
    }
    win.on('mousemove', onMoveEv)
    win.on('mouseup', onUp)
  }

  useEffect(() => {
    beginClipDragRef.current = beginClipDrag
  })

  /** Mousedown on a clip body / trim handle. Stable identity (memoized rows). */
  const onClipMouseDown = useCallback<ClipMouseDown>(
    (e, clipId, mode) => {
      const st = useEditor.getState()
      const clip = st.project.clips.find((c) => c.id === clipId)
      if (!clip) return
      const wasSelected = st.selection.includes(clipId)
      if (e.button === 2) {
        // Right-click: make sure the context menu acts on a selected clip.
        if (!wasSelected) st.setSelection([clipId])
        return
      }
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const track = st.project.tracks.find((t) => t.id === clip.trackId)

      if (razorRef.current) {
        // Razor: cut only this clip at the clicked time.
        if (track?.locked) return
        if (clip.isLive) {
          warnLiveSplit(toast)
          return
        }
        const rect = tracksRef.current?.getBoundingClientRect()
        if (!rect) return
        st.splitAt((e.clientX - rect.left) / st.zoom, undefined, [clip.id])
        return
      }

      if (mode === 'move' && e.shiftKey) {
        if (wasSelected) {
          st.setSelection(st.selection.filter((x) => x !== clipId))
          return // just deselected — nothing to drag
        }
        st.setSelection([...st.selection, clipId])
      } else if (!wasSelected) {
        st.setSelection([clipId])
      }
      if (clip.isLive || track?.locked) return
      beginClipDragRef.current(
        e,
        clip,
        mode,
        wasSelected && !e.shiftKey && mode === 'move',
      )
    },
    [toast],
  )

  function onTracksMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    // Clips, transition chips and buttons handle their own mousedown. Only a
    // press on empty track area starts a marquee / clears the selection.
    const target = e.target as HTMLElement
    if (target.closest('[data-clip],button,input,select,[data-no-marquee]')) return
    if (razorMode) return // razor on empty space does nothing
    e.preventDefault()
    const container = e.currentTarget
    const rect = container.getBoundingClientRect()
    const x0 = e.clientX - rect.left
    const y0 = e.clientY - rect.top
    if (!e.shiftKey) setSelection([])
    const baseSelection = e.shiftKey ? [...selection] : []
    setMarquee({ x0, y0, x1: x0, y1: y0 })

    // Precompute track Y bands.
    const bands: { id: string; top: number; bottom: number }[] = []
    let off = 0
    for (const t of tracks) {
      bands.push({ id: t.id, top: off, bottom: off + t.height })
      off += t.height
    }

    const update = (m: MouseEvent) => {
      const r = container.getBoundingClientRect()
      const x1 = m.clientX - r.left
      const y1 = m.clientY - r.top
      setMarquee({ x0, y0, x1, y1 })
      const x = Math.min(x0, x1)
      const w = Math.abs(x1 - x0)
      const y = Math.min(y0, y1)
      const h = Math.abs(y1 - y0)
      const hit = new Set(baseSelection)
      for (const clip of useEditor.getState().project.clips) {
        const band = bands.find((b) => b.id === clip.trackId)
        if (!band) continue
        const cx = clip.timelineStart * zoom
        const cw = clipDurationSec(clip) * zoom
        if (cx + cw < x || cx > x + w) continue
        if (band.bottom < y || band.top > y + h) continue
        hit.add(clip.id)
      }
      setSelection([...hit])
    }
    const up = () => {
      win.off('mousemove', update)
      win.off('mouseup', up)
      setMarquee(null)
    }
    win.on('mousemove', update)
    win.on('mouseup', up)
  }

  return (
    <section className="h-full flex flex-col bg-surface">
      <div className="px-3 py-2 border-b border-bd flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          Timeline
        </span>
        <AddTrackRow inline />
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 text-[11px] text-muted font-mono">
          <button
            onClick={() => setZoom(zoom / 1.25)}
            className="btn-ghost !px-1.5 !py-0.5"
            title="Zoom out"
          >
            −
          </button>
          <span className="tabular-nums">{Math.round(zoom)} px/s</span>
          <button
            onClick={() => setZoom(zoom * 1.25)}
            className="btn-ghost !px-1.5 !py-0.5"
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={fitToView}
            className="btn-ghost !px-1.5 !py-0.5"
            title="Fit timeline to view"
          >
            Fit
          </button>
          <select
            value=""
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (!Number.isNaN(v) && v > 0) setZoom(v)
            }}
            className="bg-surface2 border border-bd rounded text-[11px] px-1 py-0.5 text-muted hover:text-fg"
            title="Zoom preset"
          >
            <option value="">⋯</option>
            <option value="20">20 px/s</option>
            <option value="50">50 px/s</option>
            <option value="100">100 px/s</option>
            <option value="200">200 px/s</option>
            <option value="400">400 px/s</option>
          </select>
          <span className="mx-1 opacity-30">·</span>
          <span className="kbd">S</span>
          <span>split</span>
          <span className="kbd">Space</span>
          <span>play</span>
          <span className="mx-1 opacity-30">·</span>
          <span className="kbd">Alt</span>
          <span>no-snap</span>
          <span className="kbd">⇧Del</span>
          <span>ripple</span>
          <span className="mx-1 opacity-30">·</span>
          <button
            onClick={() => setRazorMode((v) => !v)}
            title="Toggle razor mode (R)"
            className={
              'px-2 py-0.5 rounded text-[10px] font-semibold font-sans transition-colors ' +
              (razorMode
                ? 'bg-accent text-white'
                : 'bg-surface2 text-muted hover:text-fg border border-bd')
            }
            aria-pressed={razorMode}
          >
            RAZOR
          </button>
        </div>
      </div>

      <div
        className="flex-1 grid min-h-0"
        style={{ gridTemplateColumns: `${headerW}px 4px 1fr` }}
      >
        {/* Header column */}
        <div className="flex flex-col bg-surface2/40 min-h-0">
          <div className="border-b border-bd shrink-0" style={{ height: RULER_H }} />
          <div
            ref={headerListRef}
            className="overflow-y-scroll scrollbar-none flex-1 min-h-0"
          >
            {tracks.map((t) => (
              <TrackHeader key={t.id} track={t} />
            ))}
          </div>
        </div>

        {/* Resize handle */}
        <div
          className="relative flex items-stretch cursor-col-resize select-none group border-x border-bd hover:border-accent/60 transition-colors z-10"
          onPointerDown={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            const startX = e.clientX
            const startW = headerW
            const onMove = (ev: PointerEvent) => {
              const next = Math.max(
                MIN_HEADER_W,
                Math.min(MAX_HEADER_W, startW + ev.clientX - startX),
              )
              setHeaderW(next)
            }
            const onUp = () => {
              win.off('pointermove', onMove)
              win.off('pointerup', onUp)
            }
            win.on('pointermove', onMove)
            win.on('pointerup', onUp, { once: true })
          }}
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-bd group-hover:bg-accent/60 transition-colors" />
        </div>

        {/* Content column */}
        <div ref={scrollRef} className="overflow-auto relative">
          {/* Positioned + at least viewport-tall, so full-height overlays
              (playhead, markers) span every track even when scrolled. */}
          <div
            className="relative flex flex-col"
            style={{ width: contentWidth, minWidth: '100%', minHeight: '100%' }}
          >
            <div
              className="sticky top-0 z-10 shrink-0 bg-surface2/80 backdrop-blur border-b border-bd cursor-col-resize"
              style={{ height: RULER_H }}
              onMouseDown={onRulerMouseDown}
            >
              <TimelineRuler
                totalSec={totalSec}
                zoom={zoom}
                height={RULER_H}
                scrollRef={scrollRef}
              />
              {/* Marker handles live in the sticky ruler so they stay on top
                  and clickable (click = seek, shift-click = remove). */}
              {(markers ?? []).map((m) => (
                <button
                  key={m.id}
                  className="absolute bottom-0.5 w-[11px] h-[11px] -ml-[5px] bg-amber-400 rotate-45 rounded-sm"
                  style={{ left: m.time * zoom }}
                  title={`Marker @ ${m.time.toFixed(2)}s — click to seek, shift-click to remove`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    const st = useEditor.getState()
                    if (e.shiftKey) st.removeMarker(m.id)
                    else st.setPlayhead(m.time)
                  }}
                />
              ))}
              <PlayheadHead />
            </div>

            <div
              ref={tracksRef}
              className="relative flex-1"
              style={razorMode ? { cursor: 'crosshair' } : undefined}
              onMouseDown={onTracksMouseDown}
            >
              {tracks.map((t) => (
                <TrackRow
                  key={t.id}
                  track={t}
                  zoom={zoom}
                  width={contentWidth}
                  viewLeft={viewport.left}
                  viewRight={viewport.right}
                  selection={selection}
                  razor={razorMode}
                  onClipMouseDown={onClipMouseDown}
                />
              ))}
              {snapLine !== null && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-amber-400/80 pointer-events-none z-10"
                  style={{ left: snapLine * zoom }}
                />
              )}
              {marquee && (
                <div
                  className="absolute border border-accent/70 bg-accent/10 pointer-events-none"
                  style={{
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                  }}
                />
              )}
            </div>

            {/* Marker lines (span all tracks; handles are in the ruler) */}
            {(markers ?? []).map((m) => (
              <div
                key={m.id}
                className="absolute top-0 bottom-0 w-px bg-amber-400/70 pointer-events-none"
                style={{ left: m.time * zoom }}
              />
            ))}

            <PlayheadLine />
          </div>
        </div>
      </div>
    </section>
  )
}

/** Full-height playhead line. Subscribes on its own so playback only
 *  re-renders this element, not the timeline. */
function PlayheadLine() {
  const x = useEditor((s) => s.playhead * s.zoom)
  return (
    <div
      className="absolute top-0 bottom-0 left-0 z-20 pointer-events-none will-change-transform"
      style={{ transform: `translateX(${x}px)` }}
    >
      <div className="w-px h-full bg-accent shadow-[0_0_6px_rgba(124,58,237,0.7)]" />
    </div>
  )
}

/** Playhead diamond, rendered inside the sticky ruler. */
function PlayheadHead() {
  const x = useEditor((s) => s.playhead * s.zoom)
  return (
    <div
      className="absolute top-0 left-0 pointer-events-none will-change-transform"
      style={{ transform: `translateX(${x}px)` }}
    >
      <div className="absolute -top-0.5 -left-[5px] w-[11px] h-[11px] bg-accent rotate-45 rounded-sm" />
    </div>
  )
}

function AddTrackRow({ inline }: { inline?: boolean }) {
  const addTrack = useEditor((s) => s.addTrack)
  const [open, setOpen] = useState(false)

  const dropdown = open && (
    <div
      className="absolute z-20 top-full left-0 mt-1 w-36 bg-elevated border border-bd rounded-md shadow-pop p-1 flex flex-col text-[11px]"
      onMouseLeave={() => setOpen(false)}
    >
      {(['video', 'overlay', 'audio'] as const).map((k) => (
        <button
          key={k}
          className="text-left px-2 py-1 rounded hover:bg-white/5"
          onClick={() => {
            const firstId = useEditor.getState().project.tracks[0]?.id
            addTrack(k, undefined, firstId ? { beforeTrackId: firstId } : undefined)
            setOpen(false)
          }}
        >
          {k === 'video'
            ? 'Video track'
            : k === 'overlay'
              ? 'Overlay track'
              : 'Audio track'}
        </button>
      ))}
    </div>
  )

  if (inline) {
    return (
      <div className="relative shrink-0">
        <button
          className="btn-ghost !py-0.5 !px-2 !text-[11px] border border-dashed border-bd hover:border-bd2"
          onClick={() => setOpen((v) => !v)}
          title="Add track"
        >
          + Track
        </button>
        {dropdown}
      </div>
    )
  }

  return (
    <div className="px-2 py-1.5 relative">
      <button
        className="w-full btn-ghost !py-1 !px-2 !text-[11px] justify-center border border-dashed border-bd hover:border-bd2"
        onClick={() => setOpen((v) => !v)}
        title="Add track"
      >
        + Track
      </button>
      {open && (
        <div
          className="absolute z-20 left-2 right-2 mt-1 bg-elevated border border-bd rounded-md shadow-pop p-1 flex flex-col text-[11px]"
          onMouseLeave={() => setOpen(false)}
        >
          {(['video', 'overlay', 'audio'] as const).map((k) => (
            <button
              key={k}
              className="text-left px-2 py-1 rounded hover:bg-white/5"
              onClick={() => {
                const firstId = useEditor.getState().project.tracks[0]?.id
                addTrack(k, undefined, firstId ? { beforeTrackId: firstId } : undefined)
                setOpen(false)
              }}
            >
              {k === 'video'
                ? 'Video track'
                : k === 'overlay'
                  ? 'Overlay track'
                  : 'Audio track'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const TrackHeader = memo(function TrackHeader({ track }: { track: Track }) {
  const win = useWindowListeners()
  const updateTrack = useEditor((s) => s.updateTrack)
  const removeTrack = useEditor((s) => s.removeTrack)
  const moveTrack = useEditor((s) => s.moveTrack)
  const dragRef = useRef<{ lastCrossY: number; currentIdx: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [nameValue, setNameValue] = useState(track.name)
  const nameInputRef = useRef<HTMLInputElement>(null)

  function commitRename() {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== track.name) updateTrack(track.id, { name: trimmed })
    else setNameValue(track.name)
    setEditing(false)
  }

  function startTrackDrag(e: React.PointerEvent<HTMLElement>) {
    e.preventDefault()
    e.stopPropagation()
    const tracks = useEditor.getState().project.tracks
    const idx = tracks.findIndex((t) => t.id === track.id)
    if (idx < 0) return
    dragRef.current = { lastCrossY: e.clientY, currentIdx: idx }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    useEditor.getState().beginInteraction()
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const ts = useEditor.getState().project.tracks
      const h = ts[d.currentIdx]?.height ?? 48
      const dy = ev.clientY - d.lastCrossY
      if (dy > h / 2 && d.currentIdx < ts.length - 1) {
        moveTrack(track.id, 1)
        d.currentIdx++
        d.lastCrossY = ev.clientY
      } else if (dy < -(h / 2) && d.currentIdx > 0) {
        moveTrack(track.id, -1)
        d.currentIdx--
        d.lastCrossY = ev.clientY
      }
    }
    const onUp = () => {
      dragRef.current = null
      useEditor.getState().endInteraction()
      win.off('pointermove', onMove)
      win.off('pointerup', onUp)
    }
    win.on('pointermove', onMove)
    win.on('pointerup', onUp, { once: true })
  }

  const dotClass =
    track.kind === 'video'
      ? 'bg-video'
      : track.kind === 'audio'
        ? 'bg-audio'
        : track.kind === 'overlay'
          ? 'bg-overlay'
          : 'bg-muted'

  const KindIcon =
    track.kind === 'audio'
      ? track.role === 'webcam'
        ? Camera
        : Mic
      : track.kind === 'overlay'
        ? Camera
        : Monitor

  const iconBtn =
    'w-5 h-5 rounded flex items-center justify-center transition-colors hover:bg-white/10 shrink-0 '
  // Inactive secondary buttons fade in on row hover / keyboard focus but stay
  // in the tab order (opacity, not display:none). Active state always shows.
  const reveal =
    'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 '

  return (
    <div
      className="border-b border-bd px-1.5 flex items-center gap-1 text-xs group"
      style={{ height: track.height }}
    >
      <div
        onPointerDown={startTrackDrag}
        className={
          iconBtn + 'text-fg/20 hover:text-fg/60 cursor-grab active:cursor-grabbing'
        }
        title="Drag to reorder"
      >
        <GripVertical size={11} />
      </div>
      <span className={'w-1.5 h-1.5 rounded-full shrink-0 ' + dotClass} />
      <KindIcon size={11} className="shrink-0 text-muted" aria-hidden="true" />

      {editing ? (
        <input
          ref={nameInputRef}
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') {
              setNameValue(track.name)
              setEditing(false)
            }
            e.stopPropagation()
          }}
          className="flex-1 min-w-0 bg-surface1 border border-accent/60 rounded px-1 text-[11px] text-fg outline-none"
          autoFocus
        />
      ) : (
        <span
          className="truncate flex-1 min-w-0 text-[11px] cursor-text"
          title={`${track.name} (double-click to rename)`}
          onDoubleClick={() => {
            setNameValue(track.name)
            setEditing(true)
          }}
        >
          {track.name}
        </span>
      )}

      {/* Always-visible: Eye + Lock */}
      <button
        className={iconBtn + (track.hidden ? 'text-muted' : 'text-fg/70 hover:text-fg')}
        title={track.hidden ? 'Show track' : 'Hide track (excluded from output)'}
        aria-pressed={!!track.hidden}
        onClick={() => updateTrack(track.id, { hidden: !track.hidden })}
      >
        {track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
      </button>

      <button
        className={
          iconBtn + (track.locked ? 'text-accent-text' : 'text-fg/40 hover:text-fg')
        }
        title={track.locked ? 'Unlock track' : 'Lock track (editing disabled)'}
        aria-pressed={track.locked}
        onClick={() => updateTrack(track.id, { locked: !track.locked })}
      >
        {track.locked ? <Lock size={11} /> : <LockOpen size={11} />}
      </button>

      {/* Mute / Solo: visible when active, otherwise on hover / focus. */}
      <div className="flex items-center gap-0.5">
        <button
          className={
            iconBtn +
            (track.muted ? 'text-danger' : reveal + 'text-fg/40 hover:text-fg')
          }
          title={track.muted ? 'Unmute' : 'Mute'}
          aria-pressed={track.muted}
          onClick={() => updateTrack(track.id, { muted: !track.muted })}
        >
          {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
        </button>

        <button
          className={
            iconBtn +
            (track.solo ? 'text-amber-400' : reveal + 'text-fg/40 hover:text-fg')
          }
          title={track.solo ? 'Un-solo' : 'Solo'}
          aria-pressed={!!track.solo}
          onClick={() => updateTrack(track.id, { solo: !track.solo })}
        >
          <span className="text-[9px] font-bold leading-none">S</span>
        </button>

        <button
          className={iconBtn + reveal + 'text-fg/40 hover:text-danger'}
          title="Remove track"
          onClick={() => {
            if (window.confirm(`Remove track "${track.name}" and its clips?`))
              removeTrack(track.id)
          }}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
})

const TrackRow = memo(function TrackRow({
  track,
  zoom,
  width,
  viewLeft,
  viewRight,
  selection,
  razor,
  onClipMouseDown,
}: {
  track: Track
  zoom: number
  width: number
  viewLeft: number
  viewRight: number
  selection: string[]
  razor: boolean
  onClipMouseDown: ClipMouseDown
}) {
  const [dropHint, setDropHint] = useState<number | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  // This track's clips. useShallow keeps the previous array while its
  // elements are unchanged, so edits on other tracks don't re-render this row.
  const clips = useEditor(
    useShallow((s) => s.project.clips.filter((c) => c.trackId === track.id)),
  )

  // Memoize visible clips. This avoids re-computing the viewport filter
  // on every re-render caused by unrelated store changes.
  // The ~400 px margin keeps hover / drag targets alive near the edges.
  const VIRT_MARGIN = 400
  const visibleClips = useMemo(
    () =>
      clips.filter((c) => {
        const durSec = clipDurationSec(c)
        const left = c.timelineStart * zoom
        const w = Math.max(2, durSec * zoom)
        return left + w >= viewLeft - VIRT_MARGIN && left <= viewRight + VIRT_MARGIN
      }),
    [clips, viewLeft, viewRight, zoom],
  )

  return (
    <div
      ref={rowRef}
      className={
        'relative border-b border-bd hover:bg-white/[0.015] ' +
        (dropHint !== null ? 'bg-accent/10' : '')
      }
      style={{ height: track.height, width }}
      onDragOver={(e) => {
        if (track.locked) return
        if (
          !e.dataTransfer.types.includes('application/x-ir-source') &&
          !(
            track.kind === 'overlay' &&
            (e.dataTransfer.types.includes(ELEMENT_DRAG_MIME) ||
              e.dataTransfer.types.includes(SHAPE_DRAG_MIME))
          )
        )
          return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        const rect = rowRef.current?.getBoundingClientRect()
        if (!rect) return
        setDropHint(Math.max(0, (e.clientX - rect.left) / zoom))
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropHint(null)
      }}
      onDrop={(e) => {
        if (track.locked) return
        const id = e.dataTransfer.getData('application/x-ir-source')
        const elementId = e.dataTransfer.getData(ELEMENT_DRAG_MIME)
        const shapeType = e.dataTransfer.getData(SHAPE_DRAG_MIME)
        const shape = isShapeType(shapeType) ? shapeType : null
        if (!id && !((elementId || shape) && track.kind === 'overlay')) return
        e.preventDefault()
        const rect = rowRef.current?.getBoundingClientRect()
        const t = rect ? Math.max(0, (e.clientX - rect.left) / zoom) : 0
        setDropHint(null)
        if (!id) {
          if (shape) useEditor.getState().addShapeClip(shape, t, track.id)
          else useEditor.getState().addElementClip(elementId, t, track.id)
          return
        }
        dropSourceOnTrack(track.id, id, t)
      }}
    >
      {dropHint !== null && (
        <div
          className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none"
          style={{ left: dropHint * zoom }}
        />
      )}
      {visibleClips.map((c) => {
        const durSec = clipDurationSec(c)
        return (
          <ClipChrome
            key={c.id}
            clip={c}
            track={track}
            left={c.timelineStart * zoom}
            width={Math.max(2, durSec * zoom)}
            durSec={durSec}
            zoom={zoom}
            selected={selection.includes(c.id)}
            razor={razor}
            onClipMouseDown={onClipMouseDown}
          />
        )
      })}
      <CrossfadeLayer track={track} clips={clips} zoom={zoom} />
    </div>
  )
})

const ClipChrome = memo(function ClipChrome({
  clip,
  track,
  left,
  width,
  durSec,
  zoom,
  selected,
  razor,
  onClipMouseDown,
}: {
  clip: Clip
  track: Track
  left: number
  width: number
  durSec: number
  /** Pixels per second. */
  zoom: number
  selected: boolean
  razor: boolean
  onClipMouseDown: ClipMouseDown
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }
  const source = useEditor(
    (s) => s.project.sources.find((x) => x.id === clip.sourceId) ?? null,
  )
  const wantsThumbs =
    !!source &&
    (track.kind === 'video' || track.kind === 'overlay') &&
    source.kind === 'video' &&
    !clip.isLive
  const wantsWave =
    !!source && track.kind === 'audio' && source.kind === 'audio' && !clip.isLive

  const thumbs = useThumbnails(
    wantsThumbs ? source.id : null,
    wantsThumbs ? source.opfsPath : null,
    wantsThumbs ? source.duration : 0,
  )
  const poster = usePoster(
    source &&
      (source.kind === 'animation' ||
        source.kind === 'element' ||
        source.kind === 'shape') &&
      !clip.isLive
      ? source
      : null,
  )
  const peaks = useWaveform(
    wantsWave ? source.id : null,
    wantsWave ? source.opfsPath : null,
  )

  const tone =
    track.kind === 'audio'
      ? 'from-audio/30 to-audio/10 border-audio/40 text-audio'
      : track.kind === 'overlay'
        ? 'from-overlay/30 to-overlay/10 border-overlay/40 text-overlay'
        : 'from-video/30 to-video/10 border-video/40 text-video'

  return (
    <div
      data-clip
      // Keyboard: Tab reaches clips, Enter selects (Shift/Ctrl+Enter adds or
      // removes); Delete, S, [ / ] etc. then act on the selection. Space
      // stays play/pause.
      role="button"
      tabIndex={clip.isLive ? -1 : 0}
      aria-pressed={selected}
      aria-label={`${source?.name ?? 'Clip'}, ${durSec.toFixed(1)} seconds${
        track.locked ? ', locked' : ''
      }`}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || clip.isLive) return
        e.preventDefault()
        const st = useEditor.getState()
        if (e.shiftKey || e.ctrlKey || e.metaKey)
          st.setSelection(
            st.selection.includes(clip.id)
              ? st.selection.filter((x) => x !== clip.id)
              : [...st.selection, clip.id],
          )
        else st.setSelection([clip.id])
      }}
      onMouseDown={(e) => onClipMouseDown(e, clip.id, 'move')}
      onContextMenu={onContextMenu}
      className={
        'absolute top-1.5 bottom-1.5 rounded-md border overflow-hidden select-none ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ' +
        'bg-gradient-to-b shadow-sm transition-[box-shadow,transform] ' +
        tone +
        ' ' +
        (selected ? 'ring-2 ring-accent shadow-pop ' : 'hover:shadow-md ') +
        (clip.isLive
          ? 'animate-pulse cursor-not-allowed'
          : razor
            ? 'cursor-crosshair'
            : track.locked
              ? 'cursor-default'
              : 'cursor-grab active:cursor-grabbing')
      }
      style={{ left, width }}
      title={
        clip.isLive ? `${LIVE_HINT} · ${durSec.toFixed(2)}s` : `${durSec.toFixed(2)}s`
      }
    >
      {/* Thumbnails strip for video */}
      {thumbs && thumbs.length > 0 && (
        <div className="absolute inset-0 flex opacity-70 pointer-events-none">
          {thumbs.map((src, i) => (
            <img
              key={i}
              src={src}
              alt=""
              className="h-full object-cover"
              style={{ width: `${100 / thumbs.length}%` }}
              draggable={false}
            />
          ))}
        </div>
      )}

      {poster && (
        <img
          src={poster}
          alt=""
          className="absolute left-0 top-0 h-full object-contain opacity-80 pointer-events-none"
          draggable={false}
        />
      )}

      {/* Waveform for audio */}
      {peaks && peaks.length > 0 && (
        <Waveform
          peaks={peaks}
          sourceIn={clip.sourceIn}
          sourceOut={clip.sourceOut}
          sourceDuration={source?.duration ?? 0}
        />
      )}

      {!clip.isLive && !razor && (
        <div
          onMouseDown={(e) => onClipMouseDown(e, clip.id, 'trim-start')}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/10 hover:bg-white/40 z-10"
        />
      )}
      <div className="relative px-2 py-1 text-[10px] font-medium truncate text-fg/95 drop-shadow">
        {clip.isLive ? (
          <>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-danger rec-dot mr-1 align-middle" />
            REC · {durSec.toFixed(1)}s
          </>
        ) : (
          <>
            <span className="opacity-60 mr-1">▸</span>
            {clip.linkGroup && (
              <Link2
                size={9}
                className="inline mr-1 align-[-1px] opacity-70"
                aria-label="Linked"
              />
            )}
            {durSec.toFixed(1)}s
          </>
        )}
      </div>
      {!razor && <EffectBars clip={clip} zoom={zoom} locked={track.locked} />}
      {!clip.isLive && !razor && (
        <div
          onMouseDown={(e) => onClipMouseDown(e, clip.id, 'trim-end')}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/10 hover:bg-white/40 z-10"
        />
      )}

      {menu && (
        <ClipContextMenu clip={clip} x={menu.x} y={menu.y} onClose={closeMenu} />
      )}
    </div>
  )
})

/** Portal-rendered right-click context menu for a clip. */
function ClipContextMenu({
  clip,
  x,
  y,
  onClose,
}: {
  clip: Clip
  x: number
  y: number
  onClose: () => void
}) {
  const splitAt = useEditor((s) => s.splitAt)
  const duplicateClip = useEditor((s) => s.duplicateClip)
  const playhead = useEditor((s) => s.playhead)
  const selection = useEditor((s) => s.selection)
  const revealSource = useEditor((s) => s.revealSource)
  const toast = useToast()
  const mergeClips = useMergeClips()
  const merging = useMergeJob((s) => s.job !== null)
  const [saving, setSaving] = useState(false)
  const live = !!clip.isLive

  async function handleSaveClip() {
    const source = useEditor
      .getState()
      .project.sources.find((s) => s.id === clip.sourceId)
    if (!source || source.kind === 'text' || !source.opfsPath) {
      toast.error('No file to save for this clip.')
      onClose()
      return
    }
    setSaving(true)
    try {
      const { readFile } = await import('../../lib/storage/opfs')
      const file = await readFile(source.opfsPath)
      const mimeBase = source.mimeType.split(';')[0]?.trim() ?? ''
      const extMap: Record<string, string> = {
        'audio/webm': 'weba',
        'audio/ogg': 'ogg',
        'audio/mp4': 'm4a',
        'audio/mpeg': 'mp3',
        'audio/wav': 'wav',
        'video/webm': 'webm',
        'video/mp4': 'mp4',
        'video/ogg': 'ogv',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
      }
      const ext = extMap[mimeBase] ?? (source.kind === 'audio' ? 'weba' : 'webm')
      const safeName = source.name.replace(/[^a-zA-Z0-9_\-. ]/g, '_') || 'clip'
      const a = document.createElement('a')
      a.href = URL.createObjectURL(file)
      a.download = `${safeName}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
      toast.success('Saved!')
    } catch (err) {
      console.error(err)
      toast.error('Failed to save clip.')
    } finally {
      setSaving(false)
      onClose()
    }
  }

  // Close on outside click or Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-clip-menu]')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Clamp menu so it doesn't go off-screen
  const menuW = 192
  const menuH = 320
  const left = Math.min(x, window.innerWidth - menuW - 8)
  const top = Math.min(y, window.innerHeight - menuH - 8)

  const durSec = clipDurationSec(clip)
  const clipEnd = clip.timelineStart + durSec
  const canSplit =
    !live && playhead > clip.timelineStart + 0.01 && playhead < clipEnd - 0.01
  const canLink = selection.length >= 2 && selection.includes(clip.id)
  const liveTitle = live ? LIVE_HINT : undefined

  const item =
    'flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-fg/80 hover:bg-white/8 hover:text-fg rounded-sm cursor-pointer w-full text-left disabled:opacity-40 disabled:cursor-default'
  const sep = <div className="my-1 border-t border-bd" />

  return (
    <div
      data-clip-menu
      className="fixed z-[200] min-w-48 bg-elevated border border-bd rounded-lg shadow-pop p-1"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {live && <div className="px-3 py-1.5 text-[11px] text-danger">{LIVE_HINT}</div>}
      <button
        className={item}
        disabled={live || saving}
        title={liveTitle}
        onClick={() => void handleSaveClip()}
      >
        <Download size={13} className="shrink-0 text-muted" />
        {saving ? 'Saving…' : 'Save clip to file'}
      </button>

      {sep}

      <button
        className={item}
        disabled={!canSplit}
        title={liveTitle}
        onClick={() => {
          splitAt(playhead, undefined, [clip.id])
          onClose()
        }}
      >
        <Scissors size={13} className="shrink-0 text-muted" />
        Split at playhead
        <span className="ml-auto text-[10px] text-muted font-mono">S</span>
      </button>

      <button
        className={item}
        disabled={live}
        title={liveTitle}
        onClick={() => {
          duplicateClip(clip.id, clipEnd + 0.01)
          onClose()
        }}
      >
        <Copy size={13} className="shrink-0 text-muted" />
        Duplicate
      </button>

      <button
        className={item}
        disabled={live}
        title={liveTitle}
        onClick={() => {
          const st = useEditor.getState()
          st.setSelection([clip.id])
          // moveClip (not updateClip) so linked clips follow.
          st.moveClip(clip.id, -clip.timelineStart)
          onClose()
        }}
      >
        <ArrowLeftToLine size={13} className="shrink-0 text-muted" />
        Move to start
      </button>

      {(canLink || clip.linkGroup) && sep}
      {canLink && (
        <button
          className={item}
          disabled={merging}
          title="Render the selected clips into one new clip (undo restores them)"
          onClick={() => {
            mergeClips(useEditor.getState().selection)
            onClose()
          }}
        >
          <Combine size={13} className="shrink-0 text-muted" />
          Merge {selection.length} clips
        </button>
      )}
      {canLink && (
        <button
          className={item}
          onClick={() => {
            const st = useEditor.getState()
            st.linkClips(st.selection)
            onClose()
          }}
        >
          <Link2 size={13} className="shrink-0 text-muted" />
          Link {selection.length} clips
        </button>
      )}
      {clip.linkGroup && (
        <button
          className={item}
          onClick={() => {
            const st = useEditor.getState()
            const ids = st.project.clips
              .filter((c) => c.linkGroup === clip.linkGroup)
              .map((c) => c.id)
            st.unlinkClips(ids)
            onClose()
          }}
        >
          <Unlink2 size={13} className="shrink-0 text-muted" />
          Unlink
        </button>
      )}

      {sep}

      <button
        className={item}
        disabled={!clip.sourceId}
        onClick={() => {
          if (clip.sourceId) revealSource(clip.sourceId)
          onClose()
        }}
      >
        <Library size={13} className="shrink-0 text-muted" />
        Reveal in Library
        <span className="ml-auto text-[10px] text-muted font-mono">F</span>
      </button>

      {sep}

      <button
        className={item + ' hover:bg-danger/10 hover:text-danger'}
        disabled={live}
        title={liveTitle}
        onClick={() => {
          deleteClips([clip.id], true, toast)
          onClose()
        }}
      >
        <Scissors size={13} className="shrink-0" />
        Ripple delete
        <span className="ml-auto text-[10px] text-muted font-mono">⇧⌫</span>
      </button>

      <button
        className={item + ' hover:bg-danger/10 hover:text-danger'}
        disabled={live}
        title={liveTitle}
        onClick={() => {
          deleteClips([clip.id], false, toast)
          onClose()
        }}
      >
        <Trash2 size={13} className="shrink-0" />
        Delete
        <span className="ml-auto text-[10px] text-muted font-mono">Del</span>
      </button>
    </div>
  )
}

const Waveform = memo(function Waveform({
  peaks,
  sourceIn,
  sourceOut,
  sourceDuration,
}: {
  peaks: Float32Array
  sourceIn: number
  sourceOut: number
  sourceDuration: number
}) {
  // Slice peaks to the visible [sourceIn, sourceOut] range in source-time.
  // Memoized: rebuilding the polygon is O(peaks) string work.
  const points = useMemo(() => {
    const total = peaks.length
    const dur = sourceDuration
    const startFrac = dur > 0 ? sourceIn / dur : 0
    const endFrac = dur > 0 ? sourceOut / dur : 1
    const startIdx = Math.max(0, Math.floor(startFrac * total))
    const endIdx = Math.min(total, Math.ceil(endFrac * total))
    const slice = peaks.subarray(startIdx, endIdx)
    const n = slice.length
    if (n === 0) return null

    // Build a symmetric polyline.
    const pts: string[] = []
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1 || 1)) * 100
      const v = Math.min(1, slice[i] ?? 0)
      const y = 50 - v * 48
      pts.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = (i / (n - 1 || 1)) * 100
      const v = Math.min(1, slice[i] ?? 0)
      const y = 50 + v * 48
      pts.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }
    return pts.join(' ')
  }, [peaks, sourceIn, sourceOut, sourceDuration])

  if (!points) return null

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <polygon points={points} fill="currentColor" className="text-audio/60" />
    </svg>
  )
})
