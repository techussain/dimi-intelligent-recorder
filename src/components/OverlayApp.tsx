import { useEffect, useRef, useState } from 'react'
import { FlipHorizontal2, Maximize, Minimize, X } from 'lucide-react'
import { OVERLAY_RELEASE_CAMERA, openWebcamStream } from '../lib/capture/webcam'

/**
 * Full-screen webcam view rendered inside the Electron floating overlay window.
 *
 * The window is frameless + transparent so the only visible content is the
 * rounded-corner video box. The entire surface is a native drag region, letting
 * the user drag it anywhere on the desktop (even over other apps).
 *
 * Receives its initial config (deviceId, mirrored) from URL search params set
 * by the main process, and live updates via window.overlayAPI.onSetParams().
 */
export function OverlayApp() {
  const params = new URLSearchParams(window.location.search)
  // undefined = default camera; OVERLAY_RELEASE_CAMERA = camera handed to
  // the recorder (main window), show nothing until told to re-open it.
  const [deviceId, setDeviceId] = useState<string | undefined>(
    () => params.get('deviceId') || undefined,
  )
  const [mirrored, setMirrored] = useState(() => params.get('mirrored') === '1')

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    window.overlayAPI?.onFullscreenChange((flag) => setIsFullscreen(flag))
  }, [])

  function handleFullscreen() {
    window.overlayAPI?.setFullscreen(!isFullscreen)
  }

  // Make the window body fully transparent so only the video is visible
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const root = document.getElementById('root')
    if (root) root.style.background = 'transparent'
  }, [])

  // Receive live updates from the main renderer (mirror toggle, new deviceId).
  // Only a string deviceId is a change ('' = default camera); messages that
  // carry just `mirrored` leave the camera alone.
  useEffect(() => {
    window.overlayAPI?.onSetParams(({ mirrored: m, deviceId: d }) => {
      if (m !== undefined) setMirrored(m)
      if (typeof d === 'string') setDeviceId(d || undefined)
    })
  }, [])

  // Acquire webcam stream
  useEffect(() => {
    let active = true
    if (deviceId === OVERLAY_RELEASE_CAMERA) {
      if (videoRef.current) videoRef.current.srcObject = null
      return
    }

    async function start() {
      try {
        // Stale saved ids fall back to the default camera.
        const stream = await openWebcamStream(deviceId)
        if (!active) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
      } catch {
        // Camera already in use or permission denied — fail silently
      }
    }

    void start()
    return () => {
      active = false
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [deviceId])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        borderRadius: 12,
        overflow: 'hidden',
        background: '#000',
        cursor: 'move',
        userSelect: 'none',
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Video fills the window — pointer-events off so drag passes through */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          transform: mirrored ? 'scaleX(-1)' : undefined,
          pointerEvents: 'none',
        }}
      />

      {deviceId === OVERLAY_RELEASE_CAMERA && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.75)',
            fontSize: 12,
            textAlign: 'center',
            padding: 12,
            pointerEvents: 'none',
          }}
        >
          Camera in use by the recording
        </div>
      )}

      {/* Control buttons — must opt out of the drag region */}
      <div
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          display: 'flex',
          gap: 4,
          WebkitAppRegion: 'no-drag',
          cursor: 'default',
        }}
      >
        <button
          onClick={() => setMirrored((m) => !m)}
          title="Mirror horizontally"
          style={btnStyle}
        >
          <FlipHorizontal2 size={14} />
        </button>
        <button
          onClick={handleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          style={btnStyle}
        >
          {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </button>
        <button
          onClick={() => window.overlayAPI?.close()}
          title="Close overlay"
          style={btnStyle}
        >
          <X size={14} />
        </button>
      </div>

      {/* Resize handle (bottom-right) — native Electron resizing handles the rest */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: 18,
          height: 18,
          WebkitAppRegion: 'no-drag',
          cursor: 'nwse-resize',
          background:
            'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.35) 50%)',
        }}
      />
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  background: 'rgba(0,0,0,0.65)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
  backdropFilter: 'blur(4px)',
}
