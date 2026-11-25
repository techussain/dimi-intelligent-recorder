import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  FlipHorizontal2,
  GripVertical,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  X,
} from 'lucide-react'
import { useEditor } from '../lib/timeline/store'
import {
  clampRect,
  useCaptureOpts,
  usePipStore,
  type PipRect,
} from '../lib/ui/pipStore'
import { useWebcamPreview } from '../lib/capture/useWebcamPreview'
import { describeCaptureError, useToast } from './ui/Toast'
import { IS_ELECTRON } from '../lib/capabilities'

const ASPECT = 16 / 9
const MIN_W = 160
const MIN_H = 90

/**
 * Convert a rect in this window's viewport (CSS px) to desktop coordinates
 * for the Electron overlay's BrowserWindow bounds. Those are DIPs, the same
 * unit as window.screenX/outerWidth, so no devicePixelRatio scaling.
 * The content area starts after the window frame / title bar / menu; side
 * borders are assumed symmetric. Page zoom other than 100% is not accounted for.
 */
function toScreenRect(r: PipRect): PipRect {
  const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2)
  const top = Math.max(0, window.outerHeight - window.innerHeight - border)
  return {
    x: Math.round(window.screenX + border + r.x),
    y: Math.round(window.screenY + top + r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }
}

// Document Picture-in-Picture is Chrome 116+. Declare the minimal API shape
// so TypeScript doesn't complain — the feature-check guards all calls.
interface DocumentPiPAPI {
  requestWindow(options?: {
    width?: number
    height?: number
    preferInitialWindowPlacement?: boolean
  }): Promise<Window>
  readonly window: Window | null
}
declare global {
  interface Window {
    documentPictureInPicture?: DocumentPiPAPI
  }
}

/**
 * Floating, draggable, resizable webcam self-view.
 *
 * In-browser mode: `position:fixed` overlay within the browser window.
 * Detached mode:   uses the Document Picture-in-Picture API to open a real
 *                  OS-level floating window that can be dragged to any corner
 *                  of the screen, sits above other apps, and survives browser
 *                  minimize. Activated via the ↗ pop-out button.
 */
export function WebcamPip() {
  const selfViewEnabled = usePipStore((s) => s.selfViewEnabled)
  const setSelfView = usePipStore((s) => s.setSelfView)
  const rect = usePipStore((s) => s.rect)
  const setRect = usePipStore((s) => s.setRect)
  const mirrored = usePipStore((s) => s.mirrored)
  const setMirrored = usePipStore((s) => s.setMirrored)

  const opts = useCaptureOpts((s) => s.opts)
  const recordingActive = useEditor((s) => s.recording.active)
  const recordingPaused = useEditor((s) => s.recording.paused)
  const webcamBorrowed = usePipStore((s) => s.webcamBorrowed)

  const autoOn = recordingActive && opts.webcam
  const visible = selfViewEnabled || autoOn

  const { stream, error } = useWebcamPreview(
    // Only open a getUserMedia stream for the self-view preview when the user
    // explicitly enabled it. When webcam recording is active without self-view
    // (autoOn path), captureManager opens its own stream — opening a second
    // concurrent stream on the same device causes errors on most cameras.
    // In Electron the self-view is the native overlay window, which opens its
    // own stream, so this window never opens one for display.
    // While the recorder borrows the stream it must stay open even if the
    // user hides the self-view, or the webcam recording would end.
    (selfViewEnabled && !IS_ELECTRON) || webcamBorrowed,
    opts.webcamDeviceId,
  )

  const isElectron = IS_ELECTRON

  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pipWinRef = useRef<Window | null>(null)
  const pipVideoRef = useRef<HTMLVideoElement | null>(null)
  const popOutHandlerRef = useRef<() => void>(() => {})
  const [detached, setDetached] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const toast = useToast()
  const errorReportedRef = useRef<string | null>(null)

  // ── publish stream to store so captureManager can borrow it ─────────────
  useEffect(() => {
    usePipStore.getState().setWebcamStream(stream)
    return () => {
      usePipStore.getState().setWebcamStream(null)
    }
  }, [stream])

  // ── stream → inline video ──────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream
    if (stream) v.play().catch(() => {})
  }, [stream])

  // ── stream → pip-window video (when detached) ─────────────────────────────
  useEffect(() => {
    const pv = pipVideoRef.current
    if (!pv) return
    if (pv.srcObject !== stream) pv.srcObject = stream
    if (stream) pv.play().catch(() => {})
  }, [stream, detached])

  // ── mirror → pip-window video ─────────────────────────────────────────────
  useEffect(() => {
    const pv = pipVideoRef.current
    if (!pv) return
    pv.style.transform = mirrored ? 'scaleX(-1)' : ''
  }, [mirrored, detached])

  // Native video PiP fallback emits enter/leave events on the inline video.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onEnter = () => setDetached(true)
    const onLeave = () => setDetached(false)
    video.addEventListener('enterpictureinpicture', onEnter)
    video.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter)
      video.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [])

  // ── error toasts ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!error) {
      errorReportedRef.current = null
      return
    }
    const key = error.message + (error.name ?? '')
    if (errorReportedRef.current === key) return
    errorReportedRef.current = key
    const { title, message } = describeCaptureError(error)
    toast.error(title, message)
  }, [error, toast])

  // ── fullscreen sync ────────────────────────────────────────────────────────
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  async function handleFullscreen() {
    if (!containerRef.current) return
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {})
    } else {
      await containerRef.current
        .requestFullscreen({ navigationUI: 'hide' })
        .catch((err: unknown) => {
          toast.error('Fullscreen failed', (err as Error).message)
        })
    }
  }

  // ── re-clamp rect on resize (skip while hidden — Chromium fires bogus dims) ──
  useEffect(() => {
    const onResize = () => {
      if (document.visibilityState === 'hidden') return
      const cur = usePipStore.getState().rect
      const next = clampRect(cur)
      if (
        next.x !== cur.x ||
        next.y !== cur.y ||
        next.width !== cur.width ||
        next.height !== cur.height
      ) {
        usePipStore.getState().setRect(next)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // TopBar dispatches this event from the Eye button so the PiP open still
  // counts as a direct user gesture.
  useLayoutEffect(() => {
    popOutHandlerRef.current = () => {
      void handlePopOut()
    }
  })

  useEffect(() => {
    const onPopOut = () => {
      popOutHandlerRef.current()
    }
    window.addEventListener('ir:self-view-pop-out', onPopOut)
    return () => window.removeEventListener('ir:self-view-pop-out', onPopOut)
  }, [])

  useEffect(() => {
    if (visible) return
    pipWinRef.current?.close()
    pipWinRef.current = null
    pipVideoRef.current = null
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {})
    }
    // Destroy the Electron native overlay when the self-view is switched off
    if (IS_ELECTRON) {
      window.electronAPI?.overlay.destroy()
    }
    setDetached(false)
  }, [visible])

  // Keep the Electron overlay in sync when the user toggles mirror
  useEffect(() => {
    if (!detached || !IS_ELECTRON) return
    window.electronAPI?.overlay.updateParams({ mirrored })
  }, [mirrored, detached])

  // ...and when the camera changes ('' = default camera).
  useEffect(() => {
    if (!detached || !IS_ELECTRON) return
    window.electronAPI?.overlay.updateParams({ deviceId: opts.webcamDeviceId ?? '' })
  }, [opts.webcamDeviceId, detached])

  // React when the user closes the overlay window externally (e.g. its X button)
  useEffect(() => {
    return window.electronAPI?.overlay.onClosed(() => setDetached(false))
  }, [])

  // In Electron, automatically open the native OS overlay instead of showing the
  // Chromium in-app preview. Runs whenever visibility changes.
  useEffect(() => {
    if (!isElectron || !window.electronAPI || !visible || detached) return
    window.electronAPI.overlay.show({
      ...toScreenRect(rect),
      deviceId: opts.webcamDeviceId ?? '',
      mirrored,
    })
    setDetached(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // ── pop-out: open Document PiP OS window (or Electron native overlay) ──────
  async function handlePopOut() {
    // ── Electron path: open a real OS-level BrowserWindow ───────────────────
    if (IS_ELECTRON) {
      window.electronAPI?.overlay.show({
        ...toScreenRect(rect),
        deviceId: opts.webcamDeviceId ?? '',
        mirrored,
      })
      setDetached(true)
      return
    }

    if (!window.documentPictureInPicture) {
      // Graceful fallback to native video PiP (no custom UI but works everywhere)
      try {
        await videoRef.current?.requestPictureInPicture()
      } catch (err) {
        toast.error('Pop out failed', (err as Error).message)
      }
      return
    }
    try {
      const pipWin = await window.documentPictureInPicture.requestWindow({
        width: rect.width,
        height: rect.height,
        preferInitialWindowPlacement: true,
      })

      // Minimal styles — no Tailwind needed, just full-bleed video
      pipWin.document.documentElement.style.cssText =
        'margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;'
      pipWin.document.body.style.cssText =
        'margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;'

      const vid = pipWin.document.createElement('video')
      vid.autoplay = true
      vid.muted = true
      vid.playsInline = true
      vid.srcObject = stream
      vid.style.cssText =
        'width:100%;height:100%;object-fit:cover;display:block;' +
        (mirrored ? 'transform:scaleX(-1);' : '')
      pipWin.document.body.appendChild(vid)
      void vid.play()

      pipVideoRef.current = vid
      pipWinRef.current = pipWin
      setDetached(true)

      pipWin.addEventListener('pagehide', () => {
        pipVideoRef.current = null
        pipWinRef.current = null
        setDetached(false)
      })
    } catch (err) {
      toast.error('Pop out failed', (err as Error).message)
    }
  }

  function handleCollapseBack() {
    if (IS_ELECTRON) {
      window.electronAPI?.overlay.destroy()
      setDetached(false)
      return
    }
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {})
    }
    pipWinRef.current?.close()
    // pagehide listener above handles cleanup
  }

  function handleClose() {
    if (detached) handleCollapseBack()
    setSelfView(false)
  }

  // ── drag ──────────────────────────────────────────────────────────────────
  function startDrag(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const start = { ...rect }
    const sx = e.clientX
    const sy = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      setRect({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy })
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onUp, { once: true })
  }

  // ── resize ────────────────────────────────────────────────────────────────
  function startResize(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const start = { ...rect }
    const sx = e.clientX
    const sy = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    document.body.style.userSelect = 'none'
    const maxW = Math.max(MIN_W, Math.floor(window.innerWidth * 0.5))
    const onMove = (ev: PointerEvent) => {
      const wByX = start.width + (ev.clientX - sx)
      const wByY = (start.height + (ev.clientY - sy)) * ASPECT
      const width = Math.min(Math.max(Math.max(wByX, wByY), MIN_W), maxW)
      const height = Math.max(MIN_H, Math.round(width / ASPECT))
      setRect({ x: start.x, y: start.y, width, height } satisfies PipRect)
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onUp, { once: true })
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="fixed z-40 rounded-lg overflow-hidden bg-black border border-bd2 shadow-pop select-none"
      style={{
        left: isFullscreen ? 0 : rect.x,
        top: isFullscreen ? 0 : rect.y,
        width: isFullscreen ? '100vw' : rect.width,
        height: isFullscreen ? '100vh' : rect.height,
        // When detached into the OS-level PiP window, hide the in-page box
        // entirely so no header / placeholder leaks into the browser capture.
        display: visible && !detached && !isElectron ? undefined : 'none',
      }}
      role="dialog"
      aria-label="Webcam self-view"
      aria-hidden={!visible || detached}
    >
      {/* ── inline video (hidden while detached so stream isn't doubled) ── */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-cover bg-black"
        style={{
          transform: mirrored ? 'scaleX(-1)' : undefined,
          visibility: detached ? 'hidden' : undefined,
        }}
      />

      {/* ── loading / error overlay (inline mode only) ── */}
      {!stream && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted text-center px-3">
          {error
            ? 'Camera unavailable'
            : recordingActive && opts.webcam
              ? 'Recording'
              : 'Starting camera…'}
        </div>
      )}

      {/* ── drag / header bar ── */}
      <div
        onPointerDown={!detached ? startDrag : undefined}
        className={
          'absolute top-0 left-0 right-0 h-7 flex items-center justify-between ' +
          'px-1.5 bg-gradient-to-b from-black/60 to-transparent ' +
          (!detached ? 'cursor-move' : '')
        }
      >
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/80">
          <GripVertical size={12} />
          {recordingActive && (
            <span
              className={
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-danger/80 text-white text-[9px] font-semibold ' +
                (recordingPaused ? '' : 'rec-dot')
              }
            >
              <span className="w-1 h-1 rounded-full bg-white" />
              {recordingPaused ? 'PAUSED' : 'REC'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 pointer-events-auto">
          {/* Mirror — only useful in inline mode; pip window mirrors itself */}
          {!detached && (
            <button
              onClick={(ev) => {
                ev.stopPropagation()
                setMirrored(!mirrored)
              }}
              onPointerDown={(ev) => ev.stopPropagation()}
              className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10"
              title={mirrored ? 'Unmirror' : 'Mirror horizontally'}
              aria-label="Toggle mirror"
            >
              <FlipHorizontal2 size={12} />
            </button>
          )}

          {/* Fullscreen toggle (inline mode only) */}
          {!detached && (
            <button
              onClick={(ev) => {
                ev.stopPropagation()
                void handleFullscreen()
              }}
              onPointerDown={(ev) => ev.stopPropagation()}
              className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? <Minimize size={12} /> : <Maximize size={12} />}
            </button>
          )}

          {/* Pop-out / collapse */}
          {detached ? (
            <button
              onClick={(ev) => {
                ev.stopPropagation()
                handleCollapseBack()
              }}
              onPointerDown={(ev) => ev.stopPropagation()}
              className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10"
              title="Bring back into browser"
              aria-label="Collapse self-view"
            >
              <Minimize2 size={12} />
            </button>
          ) : (
            <button
              onClick={(ev) => {
                ev.stopPropagation()
                void handlePopOut()
              }}
              onPointerDown={(ev) => ev.stopPropagation()}
              className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10"
              title="Pop out to OS window (can drag outside browser)"
              aria-label="Pop out self-view"
            >
              <Maximize2 size={12} />
            </button>
          )}

          {/* Close */}
          <button
            onClick={(ev) => {
              ev.stopPropagation()
              handleClose()
            }}
            onPointerDown={(ev) => ev.stopPropagation()}
            className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10"
            title="Hide self-view"
            aria-label="Close self-view"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Resize handle (inline mode only) */}
      {!detached && (
        <div
          onPointerDown={startResize}
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
          style={{
            background:
              'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.55) 50%)',
          }}
          aria-label="Resize"
        />
      )}
    </div>
  )
}
