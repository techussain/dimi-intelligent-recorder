import { useEffect, useMemo, useState } from 'react'
import { allRequiredOk, detectCapabilities, type Capability } from './lib/capabilities'
import { EditorShell } from './components/EditorShell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { HelpOverlay } from './components/HelpOverlay'
import { MobileGate } from './components/MobileGate'
import { OverlayApp } from './components/OverlayApp'
import { ToastProvider, useToast } from './components/ui/Toast'
import { WebcamPip } from './components/WebcamPip'
import { useViewport } from './lib/ui/useViewport'
import { useEditor } from './lib/timeline/store'
import { onError, offError } from './lib/errorBus'
import { installMenuBridge } from './lib/menuCommands'
import { installElectronLifecycle } from './lib/electronLifecycle'
import { BrandMark } from './components/BrandMark'

// Evaluated once at module load — URL never changes during the session.
const IS_OVERLAY = new URLSearchParams(window.location.search).get('overlay') === '1'

/**
 * Root component. Routes to the minimal OverlayApp when running inside the
 * Electron webcam overlay window, otherwise renders the full editor.
 */
export default function App() {
  if (IS_OVERLAY) return <OverlayApp />
  return <EditorApp />
}

function EditorApp() {
  const caps = useMemo(() => detectCapabilities(), [])
  const ok = allRequiredOk(caps)
  const [bypass, setBypass] = useState(false)
  const vp = useViewport()
  const recordingActive = useEditor((s) => s.recording.active)

  useEffect(() => {
    document.title = 'Dimi Intelligent Recorder'
    try {
      const saved = localStorage.getItem('ir-theme')
      if (saved === 'light' || saved === 'dark')
        document.documentElement.dataset.theme = saved
    } catch {
      // ignore
    }
  }, [])

  // Install Electron application-menu → renderer bridge.
  useEffect(() => installMenuBridge(), [])
  // Electron: stop + save a running take before the window closes.
  useEffect(() => installElectronLifecycle(), [])

  // Never swap the editor out mid-recording: the take would keep running with
  // no visible way to stop it. The gate applies once the recording ends.
  if (vp.isMobile && !recordingActive) return <MobileGate />
  if (!ok && !bypass)
    return <UnsupportedScreen caps={caps} onContinueAnyway={() => setBypass(true)} />
  return (
    <ToastProvider>
      <ErrorBusRelay />
      <ErrorBoundary>
        <EditorShell />
        <WebcamPip />
        <HelpOverlay />
      </ErrorBoundary>
    </ToastProvider>
  )
}

/**
 * Bridges the module-level error bus to the Toast context.
 * Must be rendered inside <ToastProvider>.
 */
function ErrorBusRelay() {
  const toast = useToast()
  useEffect(() => {
    const handler = (message: string) => {
      toast.error('An error occurred', message)
    }
    onError(handler)
    return () => offError(handler)
  }, [toast])
  return null
}

function UnsupportedScreen({
  caps,
  onContinueAnyway,
}: {
  caps: Capability[]
  onContinueAnyway: () => void
}) {
  return (
    <div className="h-full w-full flex items-center justify-center p-6">
      <div className="panel max-w-md w-full p-6">
        <div className="mb-3">
          <BrandMark size={40} />
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-1">
          Browser not supported
        </h1>
        <p className="text-sm text-muted mb-4">
          Use a recent Chromium browser (Chrome or Edge) with WebCodecs, OPFS and
          screen-capture APIs.
        </p>
        <ul className="space-y-1.5 text-sm mb-5">
          {caps.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <span
                className={
                  'inline-block w-1.5 h-1.5 rounded-full ' +
                  (c.ok ? 'bg-success' : 'bg-danger')
                }
              />
              <span className={c.ok ? '' : 'text-danger'}>{c.label}</span>
              {c.detail && <span className="text-muted text-xs">— {c.detail}</span>}
            </li>
          ))}
        </ul>
        <button onClick={onContinueAnyway} className="btn-ghost">
          Continue anyway
        </button>
      </div>
    </div>
  )
}
