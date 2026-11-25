import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useEditor } from '../lib/timeline/store'
import { PreviewEngine } from '../lib/compositor/previewEngine'
import { clipEnd } from '../lib/compositor/scene'
import { activePreviewEngine } from '../lib/compositor/previewEngine'
import { AudioMixer } from '../lib/audio/mixer'
import { useEffectAim, useKeyPicker, useSelectedEffect } from '../lib/effects/selection'
import { sampleEffects } from '../lib/effects/sample'
import type { SpotlightEffect, ZoomEffect } from '../lib/effects/types'
import { EffectHandles } from './preview/EffectHandles'
import { Rulers, StageGuides, ViewMenu } from './preview/ViewOverlays'
import { useViewPrefs } from './preview/viewPrefs'
import { SelectionToolbar } from './preview/SelectionToolbar'
import { ShapesMenu } from './ShapesMenu'
import {
  anchorFromPoint,
  axisAlignedBounds,
  boxAfterPatch,
  boxBase,
  collectActiveVisuals,
  computeCropPatch,
  computeResizePatch,
  localOffsetToWorld,
  normalizeDegrees,
  pointInBox,
  rotateIntoLocal,
  translateBounds,
  unionBounds,
  type Bounds,
  type Point,
  type ResizeHandleSpec,
  type VisualBox,
  type VisualOverlay,
} from '../lib/layout/geometry'
import { canvasTextMeasurer } from '../lib/layout/textMeasure'
import {
  buildSnapTargets,
  computeSnap,
  snapValue,
  type Guide,
} from '../lib/layout/snap'
import { nudgeSelection } from '../lib/layout/actions'
import {
  anchorChangePatch,
  isCroppableKind,
  uncroppedPlacement,
} from '../lib/layout/placement'
import { isAspectLocked } from '../lib/layout/transformOps'
import type { TransformPatch } from '../lib/timeline/store'
import type { ID, Project } from '../lib/timeline/types'

type ResizeHandleDef = ResizeHandleSpec & {
  cursor: string
  style: CSSProperties
}

/** One animation frame of a drag: the transforms to write + the overlay HUD. */
type DragFrame = {
  patches: TransformPatch[]
  hud: DragHud | null
}

/** A preview editing mode for one object: crop handles or the anchor point. */
type PreviewTool = { kind: 'crop' | 'anchor'; clipId: ID }

/** Smart guides + a small readout drawn while dragging. */
type DragHud = {
  guides: Guide[]
  label: string
  /** Where the readout sits (project px, the moved box's top-left). */
  at: Point
}

/** Snap distance in SCREEN px (converted to project px per drag). */
const SNAP_SCREEN_PX = 6
/** Pointer travel (screen px) before a press on an object starts moving it. */
const DRAG_START_PX = 3
const GUIDE_COLOR = '#ff2bd6'

const RESIZE_HANDLES: ResizeHandleDef[] = [
  {
    id: 'nw',
    dirX: -1,
    dirY: -1,
    cursor: 'nwse-resize',
    corner: true,
    style: { left: '0%', top: '0%', transform: 'translate(-50%, -50%)' },
  },
  {
    id: 'n',
    dirX: 0,
    dirY: -1,
    cursor: 'ns-resize',
    corner: false,
    style: { left: '50%', top: '0%', transform: 'translate(-50%, -50%)' },
  },
  {
    id: 'ne',
    dirX: 1,
    dirY: -1,
    cursor: 'nesw-resize',
    corner: true,
    style: { left: '100%', top: '0%', transform: 'translate(-50%, -50%)' },
  },
  {
    id: 'e',
    dirX: 1,
    dirY: 0,
    cursor: 'ew-resize',
    corner: false,
    style: { left: '100%', top: '50%', transform: 'translate(-50%, -50%)' },
  },
  {
    id: 'se',
    dirX: 1,
    dirY: 1,
    cursor: 'nwse-resize',
    corner: true,
    style: { left: '100%', top: '100%', transform: 'translate(-50%, -50%)' },
  },
  {
    id: 's',
    dirX: 0,
    dirY: 1,
    cursor: 'ns-resize',
    corner: false,
    style: { left: '50%', top: '100%', transform: 'translate(-50%, -50%)' },
  },
  {
    id: 'sw',
    dirX: -1,
    dirY: 1,
    cursor: 'nesw-resize',
    corner: true,
    style: { left: '0%', top: '100%', transform: 'translate(-50%, -50%)' },
  },
  {
    id: 'w',
    dirX: -1,
    dirY: 0,
    cursor: 'ew-resize',
    corner: false,
    style: { left: '0%', top: '50%', transform: 'translate(-50%, -50%)' },
  },
]

const NUDGE_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

/**
 * While playing or recording, the playhead moves every animation frame. The
 * frame itself is drawn by the playback loop, outside React; React only needs
 * the playhead for overlays (selection boxes, effect handles), so it follows
 * in steps of this many seconds then — a few re-renders per second instead
 * of ~60 of this large component. Paused, it uses the exact value.
 */
const MOVING_PLAYHEAD_STEP = 0.25

/** The current time readout; re-renders on its own, every frame. */
function PlayheadBadge() {
  const playhead = useEditor((s) => s.playhead)
  return <Badge>t = {playhead.toFixed(2)}s</Badge>
}

export function Preview() {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) =>
    s.playing || s.recording.active
      ? Math.floor(s.playhead / MOVING_PLAYHEAD_STEP) * MOVING_PLAYHEAD_STEP
      : s.playhead,
  )
  const playing = useEditor((s) => s.playing)
  const selection = useEditor((s) => s.selection)
  const setSelection = useEditor((s) => s.setSelection)
  const setTransforms = useEditor((s) => s.setTransforms)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const endInteraction = useEditor((s) => s.endInteraction)
  const recordingActive = useEditor((s) => s.recording.active)
  const viewPrefs = useViewPrefs()

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<PreviewEngine | null>(null)
  const mixerRef = useRef<AudioMixer | null>(null)
  const rafRef = useRef<number | null>(null)
  // Master clock anchors — updated on play-start and seek.
  const playheadBaseRef = useRef<number>(0) // project time when clock was started
  const clockBaseRef = useRef<number>(0) // AudioContext.currentTime at play-start
  // Last playhead value written by our own loops (playback / live follow).
  // Any other change is an external seek (ruler click, Home/End, arrows).
  const loopPlayheadRef = useRef<number | null>(null)
  // While recording: keep the playhead on the live edge until the user seeks away.
  const followLiveRef = useRef(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  // Guides / readout while dragging, and whether a drag is in progress.
  const [hud, setHud] = useState<DragHud | null>(null)
  const [dragging, setDragging] = useState(false)
  // Displayed stage size (CSS px): rulers and the floating toolbar.
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  // Crop / anchor mode (for one object) and whether Alt is held (anchor).
  const [tool, setTool] = useState<PreviewTool | null>(null)
  const [altHeld, setAltHeld] = useState(false)

  const activeVisuals = useMemo(
    () => collectActiveVisuals(project, playhead, canvasTextMeasurer),
    [project, playhead],
  )
  // Selected objects visible at the playhead (topmost first).
  const selectedVisuals = useMemo(
    () => activeVisuals.filter((overlay) => selection.includes(overlay.clip.id)),
    [activeVisuals, selection],
  )
  // Resize / rotate handles only for a single selected object.
  const singleVisual =
    selectedVisuals.length === 1 ? (selectedVisuals[0] ?? null) : null
  const groupBounds = useMemo(
    () => unionBounds(selectedVisuals.map((o) => axisAlignedBounds(o.box))),
    [selectedVisuals],
  )
  // Crop mode: one selected picture (video / image / animation).
  const canCrop = !!singleVisual && isCroppableKind(singleVisual.source.kind)
  const cropActive =
    canCrop && tool?.kind === 'crop' && tool.clipId === singleVisual.clip.id
  const anchorActive =
    !!singleVisual &&
    !cropActive &&
    (altHeld || (tool?.kind === 'anchor' && tool.clipId === singleVisual.clip.id))
  const cropClipId = cropActive ? singleVisual.clip.id : undefined
  // Leave a mode when its object is no longer the single selection.
  useEffect(() => {
    if (tool && singleVisual?.clip.id !== tool.clipId) setTool(null)
  }, [tool, singleVisual?.clip.id])
  // Alt shows the anchor point while held.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      setAltHeld(e.altKey && !e.ctrlKey && !e.metaKey)
    }
    const onBlur = () => {
      setAltHeld(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  function toggleTool(kind: PreviewTool['kind']) {
    if (!singleVisual) return
    if (kind === 'crop' && !canCrop) return
    const id = singleVisual.clip.id
    setTool((t) => (t?.kind === kind && t.clipId === id ? null : { kind, clipId: id }))
  }

  // A selected zoom / spotlight on a visible, selected media clip gets
  // on-preview handles; that clip is then drawn without its camera effects.
  const selectedEffect = useSelectedEffect((s) => s.selected)
  const effectTarget = useMemo((): {
    overlay: VisualOverlay
    effect: ZoomEffect | SpotlightEffect
  } | null => {
    if (!selectedEffect || playing) return null
    const overlay = activeVisuals.find((o) => o.clip.id === selectedEffect.clipId)
    if (!overlay || !selection.includes(overlay.clip.id)) return null
    if (overlay.source.kind === 'text') return null
    const effect = overlay.clip.effects?.find((e) => e.id === selectedEffect.effectId)
    if (!effect || (effect.type !== 'zoom' && effect.type !== 'spotlight')) return null
    return { overlay, effect }
  }, [selectedEffect, playing, activeVisuals, selection])
  // Chroma-key eyedropper armed: the next click samples the clip's frame.
  const picking = useKeyPicker((s) => s.picking)
  const pickTarget = useMemo(
    () =>
      picking && !playing
        ? (activeVisuals.find((o) => o.clip.id === picking.clipId) ?? null)
        : null,
    [picking, playing, activeVisuals],
  )
  // The preview shows the real (zoomed / spotlit) result; the un-zoomed aiming
  // view is only used while the user is dragging on the handles.
  const aiming = useEffectAim((s) => s.aiming)
  const suppressId =
    (aiming ? effectTarget?.overlay.clip.id : undefined) ??
    pickTarget?.clip.id ??
    cropClipId
  // Is the selected effect's range under the playhead, and is the rendered
  // picture cropped by a camera effect there (handles only line up uncropped)?
  const effectState = useMemo(() => {
    if (!effectTarget) return { active: false, aligned: true }
    const clip = effectTarget.overlay.clip
    const sourceT = clip.sourceIn + (playhead - clip.timelineStart) * (clip.speed || 1)
    const e = effectTarget.effect
    const active = sourceT >= e.start && sourceT < e.end
    const fx = sampleEffects(clip, playhead - clip.timelineStart, sourceT)
    const cropped =
      fx.crop.scale > 1.0001 ||
      (fx.shake?.amp ?? 0) > 0 ||
      (fx.grow?.scale ?? 1) > 1.0001 ||
      (fx.frame?.scale ?? 1) > 1.0001
    return { active, aligned: !cropped }
  }, [effectTarget, playhead])
  // Never leave the aiming flag set if the handles disappear mid-drag.
  useEffect(() => {
    if (!effectTarget) useEffectAim.getState().setAiming(false)
  }, [effectTarget])
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useKeyPicker.getState().cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking])

  useEffect(() => {
    if (!canvasRef.current) return
    const eng = new PreviewEngine()
    eng.attach(canvasRef.current, project.width, project.height)
    engineRef.current = eng
    mixerRef.current = new AudioMixer()
    return () => {
      eng.dispose()
      mixerRef.current?.dispose()
      engineRef.current = null
      mixerRef.current = null
    }
  }, [project.width, project.height])

  // Size the canvas backing store to the displayed size × DPR (the engine
  // caps it at the project resolution). Re-run on DPR changes (zoom, moving
  // the window to another monitor).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const apply = () => {
      const rect = canvas.getBoundingClientRect()
      engineRef.current?.resize(rect.width, rect.height, window.devicePixelRatio || 1)
    }
    const ro = new ResizeObserver(apply)
    ro.observe(canvas)
    let mql: MediaQueryList | null = null
    const onDprChange = () => {
      apply()
      watchDpr()
    }
    const watchDpr = () => {
      mql?.removeEventListener('change', onDprChange)
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mql.addEventListener('change', onDprChange)
    }
    watchDpr()
    apply()
    return () => {
      ro.disconnect()
      mql?.removeEventListener('change', onDprChange)
    }
  }, [project.width, project.height])

  // Runs after the engine is (re)created above, so a new engine gets it too.
  useEffect(() => {
    engineRef.current?.setDrawOptions({
      suppressEffects: suppressId,
      cropGhost: cropClipId,
    })
  }, [suppressId, cropClipId, project.width, project.height])

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.()
      dragCleanupRef.current = null
    }
  }, [])

  // Re-anchor the playback clock when the playhead is moved by anything other
  // than our own loops; otherwise the next frame would snap it back.
  useEffect(() => {
    return useEditor.subscribe((state, prev) => {
      if (state.playhead === prev.playhead) return
      if (state.playhead === loopPlayheadRef.current) return
      playheadBaseRef.current = state.playhead
      clockBaseRef.current = mixerRef.current?.contextTime() ?? 0
      if (state.recording.active) {
        const edge = liveEdge(state.project)
        followLiveRef.current = edge !== null && state.playhead >= edge - 0.25
      }
    })
  }, [])

  // When paused, trigger exactly one redraw whenever the visible state
  // changes (playhead move, project edit, selection change). No continuous loop.
  useEffect(() => {
    if (playing) return
    const eng = engineRef.current
    if (!eng) return
    const t = clampRenderTime(project, playhead)
    void eng.render(project, t, false)
    void mixerRef.current?.tick(project, t, false)
  }, [playhead, project, playing, selection])

  // While recording (and not playing back), keep redrawing so live clips show
  // the latest captured frame, and follow the live edge unless the user has
  // scrubbed elsewhere.
  useEffect(() => {
    if (!recordingActive || playing) return
    followLiveRef.current = true
    let cancelled = false
    let raf = 0
    const step = () => {
      if (cancelled) return
      const state = useEditor.getState()
      const edge = liveEdge(state.project)
      let t = state.playhead
      if (edge !== null && followLiveRef.current && edge !== state.playhead) {
        t = Math.max(0, edge)
        loopPlayheadRef.current = t
        state.setPlayhead(t)
      }
      void engineRef.current?.render(
        state.project,
        clampRenderTime(state.project, t),
        false,
      )
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [recordingActive, playing])

  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }
    // Anchor the master clock to AudioContext.currentTime at play-start.
    // This is monotonic and unaffected by rAF scheduling jitter.
    // `cancelled` guards against the loop starting (or continuing) after this
    // effect was cleaned up — resume() may settle after stop/unmount.
    let cancelled = false
    const mixer = mixerRef.current
    void mixer?.resume().then(() => {
      if (cancelled) return
      playheadBaseRef.current = useEditor.getState().playhead
      clockBaseRef.current = mixer.contextTime()

      const step = () => {
        if (cancelled) return
        const mixer2 = mixerRef.current
        const clockNow = mixer2?.contextTime() ?? 0
        const t = playheadBaseRef.current + (clockNow - clockBaseRef.current)

        const state = useEditor.getState()
        const end = state.project.duration

        if (end > 0 && t >= end) {
          loopPlayheadRef.current = end
          state.setPlayhead(end)
          state.setPlaying(false)
          // `end` is exclusive — show the last frame, not black.
          void engineRef.current?.render(
            state.project,
            clampRenderTime(state.project, end),
            false,
          )
          return
        }

        loopPlayheadRef.current = Math.max(0, t)
        state.setPlayhead(t)
        void engineRef.current?.render(state.project, t, true)
        void mixer2?.tick(state.project, t, true)
        rafRef.current = requestAnimationFrame(step)
      }
      rafRef.current = requestAnimationFrame(step)
    })
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [playing])

  // Track the displayed stage size (rulers, floating toolbar placement).
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const apply = () => {
      const r = el.getBoundingClientRect()
      setStageSize((prev) =>
        prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height },
      )
    }
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    apply()
    return () => {
      ro.disconnect()
    }
  }, [])

  /**
   * Run a pointer drag: one undo step (beginInteraction … endInteraction),
   * transforms written at most once per animation frame. `onMove` turns a
   * pointer event into the patches to apply and the HUD to draw (null = no
   * change yet). `onTap` runs instead when the gesture never moved anything.
   */
  function runDrag(
    e: ReactPointerEvent<HTMLElement>,
    cursor: string,
    onMove: (ev: PointerEvent) => DragFrame | null,
    onTap?: () => void,
  ) {
    dragCleanupRef.current?.()
    beginInteraction()
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* setPointerCapture may not be available (or the pointer id is synthetic) */
    }
    setBodyDragStyle(cursor)

    let pending: DragFrame | null = null
    let rafId: number | null = null
    const flush = () => {
      rafId = null
      if (!pending) return
      const frame = pending
      pending = null
      setTransforms(frame.patches)
      setHud(frame.hud)
    }
    let moved = false
    const move = (ev: PointerEvent) => {
      const frame = onMove(ev)
      if (!frame) return
      moved = true
      pending = frame
      if (rafId == null) rafId = requestAnimationFrame(flush)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (rafId != null) cancelAnimationFrame(rafId)
      rafId = null
      if (pending) {
        const frame = pending
        pending = null
        setTransforms(frame.patches)
      }
      dragCleanupRef.current = null
      setBodyDragStyle(null)
      setHud(null)
      setDragging(false)
      endInteraction()
      if (!moved) onTap?.()
    }

    dragCleanupRef.current = finish
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  /** Snap targets for a drag: frame, safe margins and the other objects. */
  function snapContext(rect: DOMRect, movingIds: ReadonlySet<ID>) {
    const others = activeVisuals
      .filter((o) => !movingIds.has(o.clip.id))
      .map((o) => axisAlignedBounds(o.box))
    return {
      targets: buildSnapTargets({ w: project.width, h: project.height }, others),
      threshold: (SNAP_SCREEN_PX * project.width) / Math.max(1, rect.width),
    }
  }

  /**
   * Move every object in `items` together (Shift = axis lock, Ctrl = no
   * snap). Nothing moves until the pointer travels a few px, so a click never
   * nudges an object; `onTap` runs for such a click.
   */
  function startMoveDrag(
    e: ReactPointerEvent<HTMLElement>,
    items: VisualOverlay[],
    onTap?: () => void,
  ) {
    const stage = stageRef.current
    if (!stage || items.length === 0) return
    const rect = stage.getBoundingClientRect()
    const startPoint = clientToProjectPoint(rect, e.clientX, e.clientY, project)
    const moving = items.map((o) => ({
      id: o.clip.id,
      x: o.transform.x,
      y: o.transform.y,
    }))
    const startBounds = unionBounds(items.map((o) => axisAlignedBounds(o.box)))
    if (!startBounds) return
    const { targets, threshold } = snapContext(rect, new Set(moving.map((m) => m.id)))
    const startClient = { x: e.clientX, y: e.clientY }
    let started = false

    runDrag(
      e,
      'move',
      (ev) => {
        if (!started) {
          const travel = Math.hypot(
            ev.clientX - startClient.x,
            ev.clientY - startClient.y,
          )
          if (travel < DRAG_START_PX) return null
          started = true
        }
        const p = clientToProjectPoint(rect, ev.clientX, ev.clientY, project)
        let dx = p.x - startPoint.x
        let dy = p.y - startPoint.y
        let lockX = false
        let lockY = false
        if (ev.shiftKey) {
          // Constrain to the dominant axis.
          if (Math.abs(dx) > Math.abs(dy)) {
            dy = 0
            lockY = true
          } else {
            dx = 0
            lockX = true
          }
        }
        let guides: Guide[] = []
        if (!(ev.ctrlKey || ev.metaKey)) {
          const snap = computeSnap(
            translateBounds(startBounds, dx, dy),
            { x: lockX ? [] : targets.x, y: lockY ? [] : targets.y },
            threshold,
          )
          dx += snap.dx
          dy += snap.dy
          guides = snap.guides
        }
        const b = translateBounds(startBounds, dx, dy)
        return {
          patches: moving.map((m) => ({
            id: m.id,
            patch: { x: m.x + dx, y: m.y + dy },
          })),
          hud: {
            guides,
            label: `X ${Math.round(b.left)}  Y ${Math.round(b.top)}`,
            at: { x: b.left, y: b.top },
          },
        }
      },
      onTap,
    )
  }

  function startResizeDrag(
    e: ReactPointerEvent<HTMLElement>,
    overlay: VisualOverlay,
    handle: ResizeHandleDef,
  ) {
    const stage = stageRef.current
    if (playing || !stage || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelection([overlay.clip.id])
    const rect = stage.getBoundingClientRect()
    const startBox: VisualBox = { ...overlay.box }
    const id = overlay.clip.id
    const { targets, threshold } = snapContext(rect, new Set([id]))
    // Snapping the dragged edge is exact only for an unrotated box.
    const axisAligned = Math.abs(normalizeDegrees(startBox.rotation)) < 0.01

    // Corners keep the aspect when it is locked (Shift frees it) and are free
    // when unlocked (Shift keeps it); side handles are free (Shift keeps it).
    const locked = isAspectLocked(overlay.transform)
    const startTf = { ...overlay.transform }

    runDrag(e, handle.cursor, (ev) => {
      const p = clientToProjectPoint(rect, ev.clientX, ev.clientY, project)
      const proportional = handle.corner && locked ? !ev.shiftKey : ev.shiftKey
      const fromCenter = ev.altKey
      const guides: Guide[] = []
      // The dragged edge follows the pointer; snap it (not for proportional
      // corner drags, where the other edge would move off the line again).
      if (
        axisAligned &&
        !(ev.ctrlKey || ev.metaKey) &&
        !(proportional && handle.corner)
      ) {
        const sx = handle.dirX !== 0 ? snapValue(p.x, targets.x, threshold) : null
        const sy = handle.dirY !== 0 ? snapValue(p.y, targets.y, threshold) : null
        if (sx) {
          p.x = sx.value
          guides.push(guideFor('x', sx.line, startBox))
        }
        if (sy) {
          p.y = sy.value
          guides.push(guideFor('y', sy.line, startBox))
        }
      }
      const patch = computeResizePatch(startBox, p, handle, proportional, fromCenter)
      const next = boxAfterPatch(startBox, startTf, patch)
      return {
        patches: [{ id, patch }],
        hud: {
          guides,
          label: `${Math.round(next.width)} × ${Math.round(next.height)}`,
          at: { x: next.left, y: next.top },
        },
      }
    })
  }

  /** Crop mode: a handle moves that edge of the kept region. */
  function startCropDrag(
    e: ReactPointerEvent<HTMLElement>,
    overlay: VisualOverlay,
    handle: ResizeHandleDef,
  ) {
    const stage = stageRef.current
    if (playing || !stage || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const rect = stage.getBoundingClientRect()
    const startBox: VisualBox = { ...overlay.box }
    const startTf = { ...overlay.transform }
    const id = overlay.clip.id
    const pct = (v: number | undefined) => `${Math.round((v ?? 0) * 100)}%`
    // Follow the pointer relative to the press, so the edge never jumps to it.
    const press = clientToProjectPoint(rect, e.clientX, e.clientY, project)
    const edge = localOffsetToWorld(startBox, {
      x: (handle.dirX * startBox.width) / 2,
      y: (handle.dirY * startBox.height) / 2,
    })

    runDrag(e, handle.cursor, (ev) => {
      const q = clientToProjectPoint(rect, ev.clientX, ev.clientY, project)
      const p = { x: edge.x + q.x - press.x, y: edge.y + q.y - press.y }
      const r = computeCropPatch(startBox, startTf, p, handle)
      const next = boxAfterPatch(startBox, startTf, { x: r.x, y: r.y }, r.crop ?? null)
      const c = r.crop
      return {
        patches: [{ id, patch: { x: r.x, y: r.y }, crop: c ?? null }],
        hud: {
          guides: [],
          label: `L ${pct(c?.left)}  T ${pct(c?.top)}  R ${pct(c?.right)}  B ${pct(c?.bottom)}`,
          at: { x: next.left, y: next.top },
        },
      }
    })
  }

  /** Drag the anchor crosshair; the object stays where it is on screen. */
  function startAnchorDrag(e: ReactPointerEvent<HTMLElement>, overlay: VisualOverlay) {
    const stage = stageRef.current
    if (playing || !stage || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const rect = stage.getBoundingClientRect()
    const startBox: VisualBox = { ...overlay.box }
    const startTf = { ...overlay.transform }
    const id = overlay.clip.id
    const snap = (SNAP_SCREEN_PX * project.width) / Math.max(1, rect.width)

    runDrag(e, 'crosshair', (ev) => {
      const p = clientToProjectPoint(rect, ev.clientX, ev.clientY, project)
      const a = anchorFromPoint(startBox, p, ev.ctrlKey || ev.metaKey ? 0 : snap)
      const patch = anchorChangePatch(boxBase(startBox), startTf, a.anchorX, a.anchorY)
      return {
        patches: [{ id, patch }],
        hud: {
          guides: [],
          label: `Anchor ${Math.round(a.anchorX * 100)}% ${Math.round(a.anchorY * 100)}%`,
          at: { x: startBox.left, y: startBox.top },
        },
      }
    })
  }

  function startRotateDrag(e: ReactPointerEvent<HTMLElement>, overlay: VisualOverlay) {
    const stage = stageRef.current
    if (playing || !stage || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelection([overlay.clip.id])
    const rect = stage.getBoundingClientRect()
    const box = overlay.box
    const id = overlay.clip.id
    const startPoint = clientToProjectPoint(rect, e.clientX, e.clientY, project)
    // Rotation turns about the anchor point.
    const startAngle = Math.atan2(startPoint.y - box.pivotY, startPoint.x - box.pivotX)
    const startRotation = overlay.transform.rotation

    runDrag(e, 'grabbing', (ev) => {
      const p = clientToProjectPoint(rect, ev.clientX, ev.clientY, project)
      const a1 = Math.atan2(p.y - box.pivotY, p.x - box.pivotX)
      let next = startRotation + ((a1 - startAngle) * 180) / Math.PI
      // Shift: snap to 15° increments.
      if (ev.shiftKey) next = Math.round(next / 15) * 15
      const rotation = normalizeDegrees(next)
      return {
        patches: [{ id, patch: { rotation } }],
        hud: {
          guides: [],
          label: `${Math.round(rotation)}°`,
          at: { x: box.left, y: box.top },
        },
      }
    })
  }

  /**
   * Press on an object (or empty stage). Plain click selects the topmost
   * object under the pointer and starts moving it — or moves the whole
   * selection when pressing one of several selected objects. Shift / Ctrl /
   * Cmd-click toggles an object in the selection. Alt-click cycles through
   * stacked objects. `fallback` = the object whose box received the press.
   */
  function handleObjectPointerDown(
    e: ReactPointerEvent<HTMLElement>,
    fallback?: VisualOverlay,
  ) {
    const stage = stageRef.current
    if (playing || !stage || e.button !== 0) return
    const rect = stage.getBoundingClientRect()
    const point = clientToProjectPoint(rect, e.clientX, e.clientY, project)
    // All hits, topmost first, so Alt-click can cycle below the current one.
    const hits = activeVisuals.filter((overlay) => pointInBox(point, overlay.box))
    let hit = hits[0] ?? fallback
    if (e.altKey && hits.length > 1) {
      const current = selectedVisuals[0]?.clip.id
      const currentIdx = hits.findIndex((o) => o.clip.id === current)
      hit = hits[(currentIdx + 1) % hits.length] ?? hits[0]
    }
    if (hit?.clip.id !== useSelectedEffect.getState().selected?.clipId)
      useSelectedEffect.getState().select(null)
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey
    if (!hit) {
      if (!toggle) setSelection([])
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const hitId = hit.clip.id
    const current = useEditor.getState().selection
    if (toggle) {
      if (current.includes(hitId)) {
        // Click = remove from the selection; drag = move the selection
        // (Ctrl-drag moves it without snapping).
        startMoveDrag(e, selectedVisuals, () => {
          setSelection(useEditor.getState().selection.filter((id) => id !== hitId))
        })
        return
      }
      const next = [...current, hitId]
      setSelection(next)
      startMoveDrag(
        e,
        activeVisuals.filter((o) => next.includes(o.clip.id)),
      )
      return
    }
    if (current.includes(hitId) && selectedVisuals.length > 1) {
      startMoveDrag(e, selectedVisuals)
      return
    }
    setSelection([hitId])
    startMoveDrag(e, [hit])
  }

  function handleStagePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Only presses on the empty overlay surface itself; the selection box,
    // handles and effect overlays have their own handlers.
    if (e.target !== e.currentTarget) return
    handleObjectPointerDown(e)
  }

  /**
   * Arrow keys nudge the selection (Shift = 10 px); C toggles crop mode;
   * Enter / Escape leave crop / anchor mode; Escape otherwise deselects.
   */
  function handleStageKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement
    if (t !== e.currentTarget && t.closest('button, input, select, textarea')) return
    if (playing || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.code === 'KeyC' && !e.shiftKey) {
      // Owned by the preview (the timeline ignores it from here).
      e.preventDefault()
      toggleTool('crop')
      return
    }
    if (tool && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault()
      setTool(null)
      return
    }
    const dir = NUDGE_KEYS[e.key]
    if (dir) {
      e.preventDefault()
      if (selectedVisuals.length > 0) {
        const step = e.shiftKey ? 10 : 1
        nudgeSelection(dir[0] * step, dir[1] * step)
      } else if (dir[0] !== 0) {
        // Nothing to nudge: arrows still step the playhead, as elsewhere.
        const st = useEditor.getState()
        const fps = st.project.fps || 30
        const step = e.shiftKey ? 10 / fps : 1 / fps
        st.setPlayhead(Math.max(0, st.playhead + dir[0] * step))
      }
      return
    }
    if (e.key === 'Escape' && !picking && selection.length > 0) {
      e.preventDefault()
      setSelection([])
    }
  }

  const showSelection = !effectTarget && !pickTarget

  return (
    <div className="relative flex-1 flex flex-col items-center justify-center p-4 min-h-0 overflow-hidden">
      <div className="flex-1 w-full flex items-center justify-center min-h-0">
        <div
          ref={stageRef}
          className="relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          style={{
            aspectRatio: `${project.width} / ${project.height}`,
            maxWidth: '100%',
            maxHeight: '100%',
            width: 'auto',
            height: '100%',
          }}
          tabIndex={0}
          data-preview-stage
          aria-label="Preview. Click to select objects; arrow keys nudge the selection."
          onPointerDownCapture={() => {
            stageRef.current?.focus({ preventScroll: true })
          }}
          onKeyDown={handleStageKeyDown}
        >
          <div className="absolute inset-0 bg-black rounded-lg overflow-hidden ring-1 ring-bd shadow-pop">
            <canvas
              ref={canvasRef}
              style={{ width: '100%', height: '100%', display: 'block' }}
            />
            {project.clips.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted pointer-events-none">
                <span>Nothing to preview yet</span>
                <span className="text-xs">
                  Press <span className="kbd">Record</span> to start capturing
                </span>
              </div>
            )}
            <StageGuides prefs={viewPrefs} />
          </div>
          {viewPrefs.rulers && (
            <Rulers
              projectW={project.width}
              projectH={project.height}
              displayedW={stageSize.w}
              displayedH={stageSize.h}
            />
          )}

          {!playing && (
            <div
              className="absolute inset-0"
              onPointerDown={handleStagePointerDown}
              style={{ touchAction: 'none' }}
            >
              {effectTarget && (
                <EffectHandles
                  clip={effectTarget.overlay.clip}
                  effect={effectTarget.effect}
                  aligned={effectState.aligned}
                  activeAtPlayhead={effectState.active}
                  boxStyle={boxToStyle(effectTarget.overlay.box, project)}
                  mirror={{
                    x: effectTarget.overlay.box.flipX,
                    y: effectTarget.overlay.box.flipY,
                  }}
                  toSourceUV={(cx, cy) => {
                    const rect = stageRef.current?.getBoundingClientRect()
                    if (!rect) return { u: 0.5, v: 0.5 }
                    const box = effectTarget.overlay.box
                    const p = clientToProjectPoint(rect, cx, cy, project)
                    // Undo the box rotation, normalize within the (kept)
                    // box, then undo a flip: effects use the object's own
                    // coordinates.
                    return boxUV(box, p)
                  }}
                />
              )}
              {pickTarget && (
                <div
                  className="absolute cursor-crosshair"
                  style={{
                    ...boxToStyle(pickTarget.box, project),
                    touchAction: 'none',
                  }}
                  title="Click a colour in the preview (Esc to cancel)"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.preventDefault()
                    e.stopPropagation()
                    const rect = stageRef.current?.getBoundingClientRect()
                    const picker = useKeyPicker.getState()
                    const sel = picker.picking
                    picker.cancel()
                    if (!rect || !sel) return
                    const box = pickTarget.box
                    const p = clientToProjectPoint(rect, e.clientX, e.clientY, project)
                    const kept = boxUV(box, p)
                    if (kept.u < 0 || kept.u > 1 || kept.v < 0 || kept.v > 1) return
                    // Kept region → whole source (the raw frame is uncropped).
                    const c = box.crop
                    const u = c ? c.left + kept.u * (1 - c.left - c.right) : kept.u
                    const v = c ? c.top + kept.v * (1 - c.top - c.bottom) : kept.v
                    const hex = activePreviewEngine()?.pickColor(sel.clipId, u, v)
                    if (!hex) return
                    const st = useEditor.getState()
                    st.beginInteraction()
                    st.updateEffect(sel.clipId, sel.effectId, { color: hex })
                    st.endInteraction()
                  }}
                >
                  <div className="absolute inset-0 border border-dashed border-violet-300/80 pointer-events-none" />
                  <div className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white/85 pointer-events-none">
                    Click to pick the key colour
                  </div>
                </div>
              )}
              {showSelection && selectedVisuals.length > 1 && (
                <>
                  {selectedVisuals.map((o) => (
                    <div
                      key={o.clip.id}
                      className="absolute border border-accent bg-accent/8 pointer-events-none"
                      style={boxToStyle(o.box, project)}
                      data-selection-outline={o.clip.id}
                    />
                  ))}
                  {groupBounds && (
                    <div
                      className="absolute border border-dashed border-white/70 pointer-events-none"
                      style={boundsToStyle(groupBounds, project)}
                      data-selection-group
                    />
                  )}
                </>
              )}
              {showSelection && singleVisual && cropActive && (
                <CropOverlay
                  overlay={singleVisual}
                  project={project}
                  onBodyPointerDown={(e) => {
                    handleObjectPointerDown(e, singleVisual)
                  }}
                  onHandlePointerDown={(e, handle) => {
                    startCropDrag(e, singleVisual, handle)
                  }}
                />
              )}
              {showSelection && singleVisual && !cropActive && (
                <div
                  className="absolute border border-accent bg-accent/8 shadow-[0_0_0_1px_rgba(124,58,237,0.35)] cursor-move"
                  style={{
                    ...boxToStyle(singleVisual.box, project),
                    willChange: 'transform, left, top, width, height',
                  }}
                  data-selection-box={singleVisual.clip.id}
                  onPointerDown={(e) => {
                    handleObjectPointerDown(e, singleVisual)
                  }}
                >
                  <div className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white/85 pointer-events-none">
                    {singleVisual.source.name}
                  </div>

                  <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[110%] h-5 w-px bg-accent/70 pointer-events-none" />
                  <div
                    className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[180%] flex items-center justify-center cursor-grab"
                    style={{ width: 22, height: 22 }}
                    onPointerDown={(e) => {
                      startRotateDrag(e, singleVisual)
                    }}
                  >
                    <div className="w-3.5 h-3.5 rounded-full bg-accent border border-white/80 pointer-events-none" />
                  </div>

                  {RESIZE_HANDLES.map((handle) => (
                    <div
                      key={handle.id}
                      className="absolute flex items-center justify-center"
                      style={{
                        ...handle.style,
                        width: 22,
                        height: 22,
                        cursor: handle.cursor,
                      }}
                      onPointerDown={(e) => {
                        startResizeDrag(e, singleVisual, handle)
                      }}
                    >
                      <div
                        className={
                          'border border-white/80 bg-accent pointer-events-none ' +
                          (handle.corner
                            ? 'w-3.5 h-3.5 rounded-sm'
                            : 'w-3 h-3 rounded-full')
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              {showSelection && singleVisual && anchorActive && (
                <div
                  className="absolute flex items-center justify-center cursor-crosshair"
                  style={{
                    left: `${(singleVisual.box.pivotX / project.width) * 100}%`,
                    top: `${(singleVisual.box.pivotY / project.height) * 100}%`,
                    width: 26,
                    height: 26,
                    transform: 'translate(-50%, -50%)',
                    touchAction: 'none',
                  }}
                  title="Drag to move the anchor point (rotation / scale pivot)"
                  data-anchor-handle={singleVisual.clip.id}
                  onPointerDown={(e) => {
                    startAnchorDrag(e, singleVisual)
                  }}
                >
                  <svg
                    width="26"
                    height="26"
                    viewBox="0 0 26 26"
                    className="pointer-events-none"
                  >
                    <circle
                      cx="13"
                      cy="13"
                      r="6"
                      fill="none"
                      stroke="#000"
                      strokeWidth="3"
                      opacity="0.5"
                    />
                    <circle
                      cx="13"
                      cy="13"
                      r="6"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M13 1v8M13 17v8M1 13h8M17 13h8"
                      stroke="#000"
                      strokeWidth="3"
                      opacity="0.5"
                    />
                    <path
                      d="M13 1v8M13 17v8M1 13h8M17 13h8"
                      stroke="#fff"
                      strokeWidth="1.5"
                    />
                  </svg>
                </div>
              )}
              {hud && <DragOverlay hud={hud} project={project} />}
            </div>
          )}
          {!playing &&
            !dragging &&
            showSelection &&
            groupBounds &&
            selectedVisuals.length > 0 && (
              <SelectionToolbar
                bounds={groupBounds}
                projectW={project.width}
                projectH={project.height}
                stageW={stageSize.w}
                stageH={stageSize.h}
                count={selectedVisuals.length}
                hasRotateHandle={singleVisual !== null && !cropActive}
                ids={selectedVisuals.map((o) => o.clip.id)}
                crop={
                  canCrop
                    ? {
                        active: cropActive,
                        toggle: () => {
                          toggleTool('crop')
                        },
                      }
                    : undefined
                }
                anchor={
                  singleVisual
                    ? {
                        active: tool?.kind === 'anchor',
                        toggle: () => {
                          toggleTool('anchor')
                        },
                      }
                    : undefined
                }
              />
            )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 text-[11px] font-mono text-muted">
        <Badge>
          {project.width}×{project.height}
        </Badge>
        <Badge>{project.fps} fps</Badge>
        <PlayheadBadge />
        <Badge>dur = {project.duration.toFixed(2)}s</Badge>
        <ShapesMenu />
        <ViewMenu />
      </div>
    </div>
  )
}

/** Magenta smart guides + the position / size readout during a drag. */
function DragOverlay({ hud, project }: { hud: DragHud; project: Project }) {
  const W = project.width
  const H = project.height
  return (
    <div className="absolute inset-0 pointer-events-none" data-drag-hud>
      {hud.guides.length > 0 && (
        <svg
          className="absolute inset-0 w-full h-full overflow-visible"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
        >
          {hud.guides.map((g, i) =>
            g.axis === 'x' ? (
              <line
                key={i}
                data-snap-guide={g.kind}
                x1={g.pos}
                x2={g.pos}
                y1={g.from ?? 0}
                y2={g.to ?? H}
                stroke={GUIDE_COLOR}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <line
                key={i}
                data-snap-guide={g.kind}
                y1={g.pos}
                y2={g.pos}
                x1={g.from ?? 0}
                x2={g.to ?? W}
                stroke={GUIDE_COLOR}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ),
          )}
        </svg>
      )}
      <div
        className="absolute rounded px-1.5 py-0.5 text-[10px] font-mono text-white whitespace-nowrap"
        style={{
          left: `${(hud.at.x / W) * 100}%`,
          top: `${(hud.at.y / H) * 100}%`,
          transform: 'translateY(calc(-100% - 6px))',
          background: GUIDE_COLOR,
        }}
        data-drag-readout
      >
        {hud.label}
      </div>
    </div>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="px-2 py-0.5 rounded bg-surface2 border border-bd">{children}</span>
  )
}

/** End of the furthest still-recording clip, or null when nothing is live. */
function liveEdge(project: Project): number | null {
  let edge: number | null = null
  for (const c of project.clips) {
    if (!c.isLive) continue
    const end = clipEnd(c)
    if (edge === null || end > edge) edge = end
  }
  return edge
}

/**
 * The project end is exclusive (nothing is active at t = duration), so
 * rendering there would show black; show the last frame instead. Live clips
 * are drawn inclusive of their end (the live edge), so no clamp while one
 * reaches the end.
 */
function clampRenderTime(project: Project, t: number): number {
  const end = project.duration
  if (end <= 0 || t < end) return t
  if (project.clips.some((c) => c.isLive && clipEnd(c) >= end)) return t
  return Math.max(0, end - 1 / Math.max(1, project.fps))
}

function clientToProjectPoint(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  project: Project,
): Point {
  return {
    x: ((clientX - rect.left) / rect.width) * project.width,
    y: ((clientY - rect.top) / rect.height) * project.height,
  }
}

function boxToStyle(box: VisualBox, project: Project): CSSProperties {
  return {
    left: `${(box.left / project.width) * 100}%`,
    top: `${(box.top / project.height) * 100}%`,
    width: `${(box.width / project.width) * 100}%`,
    height: `${(box.height / project.height) * 100}%`,
    transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
    transformOrigin: 'center center',
  }
}

/**
 * A frame point in the box's own coordinates: 0..1 across the kept region,
 * rotation and flip undone (what effects and the colour picker use).
 */
function boxUV(box: VisualBox, p: Point): { u: number; v: number } {
  const local = rotateIntoLocal(p, box, -box.rotation)
  const u = local.x / (box.width || 1) + 0.5
  const v = local.y / (box.height || 1) + 0.5
  return { u: box.flipX ? 1 - u : u, v: box.flipY ? 1 - v : v }
}

/**
 * Crop mode for one picture: the kept box with crop handles, and the whole
 * picture's outline (drawScene paints the cropped-away part dimmed).
 */
function CropOverlay({
  overlay,
  project,
  onBodyPointerDown,
  onHandlePointerDown,
}: {
  overlay: VisualOverlay
  project: Project
  onBodyPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onHandlePointerDown: (
    e: ReactPointerEvent<HTMLElement>,
    handle: ResizeHandleDef,
  ) => void
}) {
  const box = overlay.box
  const full = uncroppedPlacement(box.fullBase, box.crop, overlay.transform)
  const fw = Math.abs(full.w)
  const fh = Math.abs(full.h)
  return (
    <>
      <div
        className="absolute border border-dashed border-white/60 pointer-events-none"
        style={{
          left: `${((full.centerX - fw / 2) / project.width) * 100}%`,
          top: `${((full.centerY - fh / 2) / project.height) * 100}%`,
          width: `${(fw / project.width) * 100}%`,
          height: `${(fh / project.height) * 100}%`,
          transform: full.rotation ? `rotate(${full.rotation}deg)` : undefined,
        }}
        data-crop-full
      />
      <div
        className="absolute border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)] cursor-move"
        style={boxToStyle(box, project)}
        data-crop-box={overlay.clip.id}
        onPointerDown={onBodyPointerDown}
      >
        <div className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white/85 pointer-events-none whitespace-nowrap">
          Crop · drag the edges · Enter to finish
        </div>
        {RESIZE_HANDLES.map((handle) => (
          <div
            key={handle.id}
            className="absolute flex items-center justify-center"
            style={{ ...handle.style, width: 22, height: 22, cursor: handle.cursor }}
            data-crop-handle={handle.id}
            onPointerDown={(e) => {
              onHandlePointerDown(e, handle)
            }}
          >
            <div
              className={
                'bg-white border border-black/50 pointer-events-none ' +
                (handle.corner
                  ? 'w-3.5 h-3.5'
                  : handle.dirX === 0
                    ? 'w-5 h-1.5 rounded-sm'
                    : 'w-1.5 h-5 rounded-sm')
              }
            />
          </div>
        ))}
      </div>
    </>
  )
}

function boundsToStyle(b: Bounds, project: Project): CSSProperties {
  return {
    left: `${(b.left / project.width) * 100}%`,
    top: `${(b.top / project.height) * 100}%`,
    width: `${((b.right - b.left) / project.width) * 100}%`,
    height: `${((b.bottom - b.top) / project.height) * 100}%`,
  }
}

/** Guide for a resize-edge snap: object lines span both boxes. */
function guideFor(
  axis: 'x' | 'y',
  line: { pos: number; kind: Guide['kind']; start?: number; end?: number },
  box: VisualBox,
): Guide {
  const lo = axis === 'x' ? box.top : box.left
  const hi = axis === 'x' ? box.top + box.height : box.left + box.width
  return {
    axis,
    pos: line.pos,
    kind: line.kind,
    from: line.start === undefined ? null : Math.min(line.start, lo),
    to: line.end === undefined ? null : Math.max(line.end, hi),
  }
}

/** Page-wide cursor / no text selection while dragging (null = restore). */
function setBodyDragStyle(cursor: string | null): void {
  document.body.style.userSelect = cursor === null ? '' : 'none'
  document.body.style.cursor = cursor ?? ''
}
