import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Circle,
  Pause,
  Play,
  Square,
  MonitorUp,
  Mic,
  Camera,
  Volume2,
  PanelLeft,
  PanelRight,
  Download,
  Undo2,
  Redo2,
  FilePlus,
  FolderOpen,
  Save,
  Type,
  Eye,
  EyeOff,
  Settings2,
} from 'lucide-react'
import { useEditor } from '../lib/timeline/store'
import { CaptureCanceledError, getCaptureManager } from '../lib/capture/captureManager'
import { findStaleDeviceIds } from '../lib/capture/devices'
import { useCaptureOpts, usePipStore } from '../lib/ui/pipStore'
import { BrandMark } from './BrandMark'
import { CaptureOptionsMenu } from './CaptureOptionsMenu'
import { RecordSetupModal } from './RecordSetupModal'
import { describeCaptureError, useToast } from './ui/Toast'
import { ExportModal } from './ExportModal'
import { openProjectFromFile, saveProjectToFile } from '../lib/persistence/project'
import {
  openProjectBundle,
  saveProjectBundleWithPrompt,
} from '../lib/persistence/bundle'
import { IS_ELECTRON } from '../lib/capabilities'
import type { CaptureOptions } from '../lib/capture/captureManager'
import type { ID, TrackKind, TrackRole } from '../lib/timeline/types'

export interface TopBarProps {
  leftOpen: boolean
  rightOpen: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
}

export function TopBar({
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
}: TopBarProps) {
  const project = useEditor((s) => s.project)
  const recording = useEditor((s) => s.recording)
  const playing = useEditor((s) => s.playing)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setProjectName = useEditor((s) => s.setProjectName)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const pastLen = useEditor((s) => s.past.length)
  const futureLen = useEditor((s) => s.future.length)
  const newProject = useEditor((s) => s.newProject)
  const loadProject = useEditor((s) => s.loadProject)
  const addTextClip = useEditor((s) => s.addTextClip)

  const [elapsed, setElapsed] = useState(0)
  const [setupOpen, setSetupOpen] = useState(false)
  const opts = useCaptureOpts((s) => s.opts)
  const setOpts = useCaptureOpts((s) => s.setOpts)
  const patchOpts = useCaptureOpts((s) => s.patchOpts)
  const selfViewEnabled = usePipStore((s) => s.selfViewEnabled)
  const setSelfView = usePipStore((s) => s.setSelfView)
  const toast = useToast()
  const [exportOpen, setExportOpen] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  /** Cancels the running countdown (resolves it with false). */
  const cancelCountdownRef = useRef<(() => void) | null>(null)
  // OPFS storage estimate during recording: { usedMB, pct }
  const [storageEst, setStorageEst] = useState<{ usedMB: number; pct: number } | null>(
    null,
  )
  /** Last storage warning level toasted (0 none, 1 = 90 %, 2 = 95 %). */
  const storageLevelRef = useRef(0)

  useEffect(() => {
    const onOpen = () => setExportOpen(true)
    window.addEventListener('ir:open-export', onOpen)
    return () => window.removeEventListener('ir:open-export', onOpen)
  }, [])

  // Handle application-menu recording and setup commands.
  useEffect(() => {
    const onStart = () => {
      // isBusy also covers the screen picker and the countdown.
      if (!recording.active && !getCaptureManager().isBusy)
        void startWithCountdown(opts)
    }
    const onStop = () => {
      if (recording.active) void handleStop()
    }
    const onPause = () => handlePauseToggle()
    const onSetup = () => setSetupOpen(true)
    window.addEventListener('ir:start-recording', onStart)
    window.addEventListener('ir:stop-recording', onStop)
    window.addEventListener('ir:toggle-pause', onPause)
    window.addEventListener('ir:open-record-setup', onSetup)
    return () => {
      window.removeEventListener('ir:start-recording', onStart)
      window.removeEventListener('ir:stop-recording', onStop)
      window.removeEventListener('ir:toggle-pause', onPause)
      window.removeEventListener('ir:open-record-setup', onSetup)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.active, recording.paused, opts])

  useEffect(() => {
    if (!recording.active || !recording.startedAt) {
      setElapsed(0)
      return
    }
    const tick = () => {
      const now = Date.now()
      const paused = recording.paused && recording.pausedAt != null
      const frozenNow = paused ? (recording.pausedAt ?? now) : now
      const ms = frozenNow - (recording.startedAt ?? 0) - recording.pausedAccumMs
      setElapsed(Math.max(0, Math.floor(ms / 1000)))
    }
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [
    recording.active,
    recording.startedAt,
    recording.paused,
    recording.pausedAt,
    recording.pausedAccumMs,
  ])

  // Poll OPFS storage estimate every 10 s while recording is active.
  useEffect(() => {
    storageLevelRef.current = 0
    if (!recording.active) {
      setStorageEst(null)
      return
    }
    let cancelled = false
    async function poll() {
      try {
        const est = await navigator.storage.estimate()
        if (cancelled) return
        const used = est.usage ?? 0
        const quota = est.quota ?? 1
        const pct = Math.min(100, Math.round((used / quota) * 100))
        const usedMB = Math.round(used / 1024 / 1024)
        setStorageEst({ usedMB, pct })
        // Toast once per threshold crossing, not on every poll.
        const level = pct >= 95 ? 2 : pct >= 90 ? 1 : 0
        const prevLevel = storageLevelRef.current
        storageLevelRef.current = level
        if (level <= prevLevel) return
        if (level === 2) {
          toast.withAction(
            'Storage critical',
            {
              label: 'Stop recording',
              onClick: () => {
                void handleStop()
              },
            },
            `${pct}% of quota used — stop recording to avoid data loss.`,
          )
        } else {
          toast.info('Storage warning', `${pct}% of OPFS quota used.`)
        }
      } catch {
        // estimate() may be unavailable in some environments — fail silently.
      }
    }
    void poll()
    const id = window.setInterval(() => {
      void poll()
    }, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.active])

  // Forget saved mic/camera ids that no longer match a connected device
  // (checked at startup and whenever devices change).
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const { micDeviceId, webcamDeviceId } = useCaptureOpts.getState().opts
      try {
        const stale = await findStaleDeviceIds({ micDeviceId, webcamDeviceId })
        if (cancelled) return
        if (stale.mic) {
          patchOpts({ micDeviceId: undefined })
          toast.info('Microphone not found', 'Switched to the default microphone.')
        }
        if (stale.webcam) {
          patchOpts({ webcamDeviceId: undefined })
          toast.info('Camera not found', 'Switched to the default camera.')
        }
      } catch {
        // enumerateDevices unavailable — keep the saved choice.
      }
    }
    const onChange = () => void check()
    void check()
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc cancels the countdown.
  useEffect(() => {
    if (countdown === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancelCountdownRef.current?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [countdown])

  /**
   * Pick a distinct track for every enabled source: role-designated tracks
   * first, then role-less tracks of the right kind. A source with no track
   * gets a new one (tagged with its role so the next take finds it). Never
   * assigns two sources to the same track.
   */
  function resolveTargets(o: CaptureOptions) {
    // Always read tracks from the live store — not from the React closure —
    // so keyboard shortcuts and menu commands see current track state.
    const store = useEditor.getState()
    const tracks = store.project.tracks
    const used = new Set<ID>()
    const wanted: Array<{
      role: TrackRole
      kind: TrackKind
      name: string
      on: boolean
    }> = [
      { role: 'screen', kind: 'video', name: 'Screen', on: o.screen },
      { role: 'webcam', kind: 'overlay', name: 'Webcam', on: o.webcam },
      {
        role: 'system-audio',
        kind: 'audio',
        name: 'System audio',
        on: o.screen && o.systemAudio,
      },
      { role: 'mic', kind: 'audio', name: 'Mic', on: o.mic },
    ]
    const ids = new Map<TrackRole, ID>()
    // Pass 1: exact roles. Pass 2: role-less tracks of the same kind.
    for (const w of wanted) {
      if (!w.on) continue
      const t = tracks.find((x) => x.role === w.role && !used.has(x.id))
      if (t) {
        used.add(t.id)
        ids.set(w.role, t.id)
      }
    }
    for (const w of wanted) {
      if (!w.on || ids.has(w.role)) continue
      const t = tracks.find((x) => x.kind === w.kind && !x.role && !used.has(x.id))
      if (t) {
        used.add(t.id)
        ids.set(w.role, t.id)
      }
    }
    const missing = wanted.filter((w) => w.on && !ids.has(w.role))
    if (missing.length) {
      // One undo step for all created tracks.
      store.beginInteraction()
      try {
        for (const w of missing) {
          const id = store.addTrack(w.kind, w.name, { role: w.role })
          ids.set(w.role, id)
        }
      } finally {
        store.endInteraction()
      }
    }
    // Track order is stacking order (top track drawn on top). Projects made
    // before the default order was fixed have the webcam track below the
    // screen track, where the full-frame screen recording hides it: move it
    // directly above the screen track.
    const screenId = ids.get('screen')
    const webcamId = ids.get('webcam')
    if (screenId && webcamId) {
      const order = useEditor.getState().project.tracks
      const si = order.findIndex((t) => t.id === screenId)
      const wi = order.findIndex((t) => t.id === webcamId)
      if (si >= 0 && wi > si) useEditor.getState().moveTrack(webcamId, si - wi)
    }
    return {
      screenTrackId: ids.get('screen') ?? '',
      webcamTrackId: ids.get('webcam'),
      systemAudioTrackId: ids.get('system-audio'),
      micTrackId: ids.get('mic'),
    }
  }

  /** 3-2-1 countdown. Resolves false if cancelled (Esc, click, Cancel). */
  function runCountdown(): Promise<boolean> {
    return new Promise((resolve) => {
      let n = 3
      let timer = 0
      const finish = (ok: boolean) => {
        window.clearTimeout(timer)
        cancelCountdownRef.current = null
        setCountdown(null)
        resolve(ok)
      }
      cancelCountdownRef.current = () => finish(false)
      const tick = () => {
        n -= 1
        if (n <= 0) finish(true)
        else {
          setCountdown(n)
          timer = window.setTimeout(tick, 1000)
        }
      }
      setCountdown(n)
      timer = window.setTimeout(tick, 1000)
    })
  }

  async function handleStart(confirmedOpts: CaptureOptions) {
    const mgr = getCaptureManager()
    if (mgr.isBusy) return
    mgr.onStreamEnded = (reason) => toast.info('Capture ended', reason)
    mgr.onRecorderError = (err) => {
      const { title, message } = describeCaptureError(err)
      toast.error(title, message)
    }
    mgr.onSourceSkipped = (label, err) => {
      toast.info(
        `Recording without ${label.toLowerCase()}`,
        err ? describeCaptureError(err).message : `${label} was not available.`,
      )
    }
    mgr.onStaleDevice = (kind) => {
      if (kind === 'mic') {
        patchOpts({ micDeviceId: undefined })
        toast.info('Microphone not found', 'Using the default microphone.')
      } else {
        patchOpts({ webcamDeviceId: undefined })
        toast.info('Camera not found', 'Using the default camera.')
      }
    }
    mgr.onFinalizing = (active) => {
      if (active)
        toast.info(
          'Finalizing recording…',
          'Indexing the recorded files for fast seeking.',
        )
    }
    const targets = resolveTargets(confirmedOpts)
    const pipStream = usePipStore.getState().webcamStream
    try {
      // Streams are acquired first (the browser's screen picker appears
      // now), then the countdown runs, then all recorders start together.
      const started = await mgr.start(
        {
          ...confirmedOpts,
          // Reuse the self-view stream when available to avoid a second
          // concurrent getUserMedia on the same camera device.
          ...(pipStream ? { webcamStream: pipStream } : {}),
        },
        targets,
        runCountdown,
      )
      if (!started) toast.info('Recording canceled')
    } catch (err) {
      if (err instanceof CaptureCanceledError) {
        toast.info('Recording canceled')
        return
      }
      const { title, message } = describeCaptureError(err)
      toast.error(title, message)
    }
  }
  async function handleStop() {
    await getCaptureManager().stop()
  }

  function startWithCountdown(confirmedOpts: CaptureOptions): Promise<void> {
    return handleStart(confirmedOpts)
  }
  function handlePauseToggle() {
    const mgr = getCaptureManager()
    if (!mgr.isRecording) return
    if (recording.paused) mgr.resume()
    else mgr.pause()
  }

  function handleSelfViewToggle() {
    if (selfViewEnabled) {
      setSelfView(false)
      return
    }
    setSelfView(true)
    // Dispatch synchronously from the button click so the PiP API still sees
    // a user activation and can open a real OS-level floating window.
    window.dispatchEvent(new CustomEvent('ir:self-view-pop-out'))
  }

  function handleNewProject() {
    if (recording.active) return
    if (project.clips.length > 0) {
      const ok = window.confirm(
        'Start a new project? Your current work is autosaved — reopen it any time from the command palette (Ctrl+K → Recent projects).',
      )
      if (!ok) return
    }
    newProject()
    toast.info('New project')
  }

  async function handleOpenProject() {
    if (recording.active) return
    try {
      const p = await openProjectFromFile()
      if (!p) return
      if (!loadProject(p)) return
      toast.success('Project loaded', p.name)
    } catch (err) {
      toast.error('Open failed', (err as Error).message)
    }
  }

  async function handleSaveProject() {
    try {
      if (await saveProjectToFile(project)) toast.success('Project saved')
    } catch (err) {
      toast.error('Save failed', (err as Error).message)
    }
  }

  async function handleSaveBundle() {
    try {
      if (await saveProjectBundleWithPrompt(project))
        toast.success('Bundle saved', 'Portable .irbundle with embedded media')
    } catch (err) {
      toast.error('Bundle save failed', (err as Error).message)
    }
  }

  async function handleOpenBundle() {
    if (recording.active) return
    try {
      const p = await openProjectBundle()
      if (!p) return
      if (!loadProject(p)) return
      toast.success('Bundle loaded', p.name)
    } catch (err) {
      toast.error('Bundle open failed', (err as Error).message)
    }
  }

  return (
    <header
      className="h-14 shrink-0 px-3 flex items-center gap-2
        border-b border-bd bg-surface/80 backdrop-blur
        supports-[backdrop-filter]:bg-surface/60"
    >
      {/* Brand — in Electron it lives in the custom TitleBar instead. */}
      {!IS_ELECTRON && (
        <>
          <div className="flex items-center gap-2 pr-2">
            <BrandMark size={28} />
            <span className="font-semibold tracking-tight hidden sm:inline">
              Dimi&nbsp;Intelligent&nbsp;Recorder
            </span>
          </div>

          <div className="w-px h-6 bg-bd mx-1" />
        </>
      )}

      {/* Left panel toggle */}
      <button
        className="btn-ghost !px-2"
        onClick={onToggleLeft}
        title={leftOpen ? 'Hide media panel' : 'Show media panel'}
      >
        <PanelLeft size={16} className={leftOpen ? 'text-fg' : 'text-muted'} />
      </button>

      {/* Project name */}
      <input
        value={project.name}
        onChange={(e) => setProjectName(e.target.value)}
        className="bg-transparent outline-none min-w-0 w-56 px-2 py-1 rounded-md
          text-sm hover:bg-white/5 focus:bg-white/5 border border-transparent
          focus:border-bd"
      />

      <div className="flex-1" />

      {/* Capture source toggles */}
      <div className="hidden md:flex items-center gap-1.5">
        <ToggleChip
          active={opts.screen}
          onClick={() =>
            !recording.active && setOpts((o) => ({ ...o, screen: !o.screen }))
          }
          icon={<MonitorUp size={12} />}
          label="Screen"
          disabled={recording.active}
        />
        <ToggleChip
          active={opts.systemAudio}
          onClick={() =>
            !recording.active && setOpts((o) => ({ ...o, systemAudio: !o.systemAudio }))
          }
          icon={<Volume2 size={12} />}
          label="System"
          disabled={recording.active}
        />
        <ToggleChip
          active={opts.mic}
          onClick={() => !recording.active && setOpts((o) => ({ ...o, mic: !o.mic }))}
          icon={<Mic size={12} />}
          label="Mic"
          disabled={recording.active}
        />
        <ToggleChip
          active={opts.webcam}
          onClick={() =>
            !recording.active && setOpts((o) => ({ ...o, webcam: !o.webcam }))
          }
          icon={<Camera size={12} />}
          label="Webcam"
          disabled={recording.active}
        />
        <CaptureOptionsMenu
          value={{
            micDeviceId: opts.micDeviceId,
            webcamDeviceId: opts.webcamDeviceId,
          }}
          onChange={(v) => patchOpts(v)}
          disabled={recording.active}
        />
      </div>

      {/* Self-view toggle — always visible, independent of capture-chip group */}
      <button
        onClick={handleSelfViewToggle}
        className={
          'btn-ghost !px-2 ' + (selfViewEnabled ? 'text-accent-text' : 'text-muted')
        }
        title={
          selfViewEnabled
            ? 'Hide webcam self-view'
            : 'Show webcam self-view in a floating window'
        }
        aria-pressed={selfViewEnabled}
      >
        {selfViewEnabled ? <Eye size={14} /> : <EyeOff size={14} />}
        <span className="hidden lg:inline ml-1 text-xs">Self-view</span>
      </button>

      <div className="w-px h-6 bg-bd mx-1" />

      {/* Record / transport group */}
      {!recording.active ? (
        <div className="flex items-stretch gap-0.5">
          <button
            onClick={() => setSetupOpen(true)}
            className="btn-soft gap-1.5"
            title="Recording settings"
          >
            <Settings2 size={13} /> Sources
          </button>
          <button
            onClick={() => void startWithCountdown(opts)}
            className="btn-danger gap-1.5"
            title="Start recording with current settings"
            disabled={countdown !== null}
          >
            <Circle size={12} fill="currentColor" /> Record
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-danger-soft border border-danger/30 text-danger font-mono text-xs">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-danger rec-dot" />
            {fmt(elapsed)}
            {recording.paused && <span className="opacity-70 ml-1">PAUSED</span>}
            {storageEst !== null && (
              <span
                className={
                  'ml-2 text-[10px] font-sans ' +
                  (storageEst.pct >= 90 ? 'text-amber-400' : 'opacity-60')
                }
                title={`${storageEst.usedMB} MB used`}
              >
                {storageEst.pct}%
              </span>
            )}
          </div>
          <button onClick={handlePauseToggle} className="btn-soft">
            {recording.paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button
            onClick={() => {
              void handleStop()
            }}
            className="btn-soft"
          >
            <Square size={13} /> Stop
          </button>
        </div>
      )}

      <button
        onClick={() => setPlaying(!playing)}
        className="btn-soft gap-1.5"
        title="Play / pause preview (Space)"
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
        <span className="hidden lg:inline">{playing ? 'Pause' : 'Play'}</span>
      </button>

      <div className="w-px h-6 bg-bd mx-1" />

      <button
        onClick={undo}
        disabled={pastLen === 0 || recording.active}
        className="btn-ghost !px-2 disabled:opacity-30 disabled:cursor-not-allowed"
        title={recording.active ? 'Undo is disabled while recording' : 'Undo (Ctrl+Z)'}
      >
        <Undo2 size={14} />
      </button>
      <button
        onClick={redo}
        disabled={futureLen === 0 || recording.active}
        className="btn-ghost !px-2 disabled:opacity-30 disabled:cursor-not-allowed"
        title={
          recording.active ? 'Redo is disabled while recording' : 'Redo (Ctrl+Shift+Z)'
        }
      >
        <Redo2 size={14} />
      </button>

      <div className="w-px h-6 bg-bd mx-1" />

      <button
        onClick={handleNewProject}
        disabled={recording.active}
        className="btn-ghost !px-2 disabled:opacity-30 disabled:cursor-not-allowed"
        title="New project"
      >
        <FilePlus size={14} />
      </button>
      <button
        onClick={(e) => {
          // Shift+click is handled on mousedown (bundle); don't also open .irproj.
          if (!e.shiftKey) void handleOpenProject()
        }}
        disabled={recording.active}
        className="btn-ghost !px-2 disabled:opacity-30 disabled:cursor-not-allowed"
        title="Open .irproj (shift+click for .irbundle)"
        onAuxClick={(e) => {
          if (e.button === 1) void handleOpenBundle()
        }}
        onMouseDown={(e) => {
          if (e.shiftKey) {
            e.preventDefault()
            void handleOpenBundle()
          }
        }}
      >
        <FolderOpen size={14} />
      </button>
      <button
        onClick={(e) => {
          if (!e.shiftKey) void handleSaveProject()
        }}
        onMouseDown={(e) => {
          if (e.shiftKey) {
            e.preventDefault()
            void handleSaveBundle()
          }
        }}
        className="btn-ghost !px-2"
        title="Save .irproj (shift+click for portable .irbundle)"
      >
        <Save size={14} />
      </button>

      <button
        // Read at click time: subscribing would re-render the bar every frame.
        onClick={() => addTextClip(null, useEditor.getState().playhead)}
        className="btn-ghost !px-2"
        title="Add text clip at playhead"
      >
        <Type size={14} />
      </button>

      <button
        className="btn-ghost gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
        title="Export video"
        disabled={project.duration <= 0 || recording.active}
        onClick={() => setExportOpen(true)}
      >
        <Download size={14} />
        <span className="hidden lg:inline">Export</span>
      </button>

      <div className="w-px h-6 bg-bd mx-1" />

      <button
        className="btn-ghost !px-2"
        onClick={onToggleRight}
        title={rightOpen ? 'Hide inspector' : 'Show inspector'}
      >
        <PanelRight size={16} className={rightOpen ? 'text-fg' : 'text-muted'} />
      </button>
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
      {countdown !== null &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-8 bg-black/60 backdrop-blur-sm cursor-pointer"
            onClick={() => cancelCountdownRef.current?.()}
            role="dialog"
            aria-label="Recording countdown — click or press Esc to cancel"
          >
            <div
              key={countdown}
              className="text-[160px] font-black text-white leading-none select-none"
              style={{
                textShadow: '0 0 60px rgba(220,50,50,0.9), 0 4px 32px rgba(0,0,0,0.8)',
                animation: 'ir-countdown-pop 0.9s ease-out forwards',
              }}
            >
              {countdown}
            </div>
            <button
              className="btn-soft"
              onClick={(e) => {
                e.stopPropagation()
                cancelCountdownRef.current?.()
              }}
            >
              Cancel
            </button>
            <style>{`
            @keyframes ir-countdown-pop {
              0%   { transform: scale(1.5); opacity: 0; }
              20%  { transform: scale(1);   opacity: 1; }
              75%  { transform: scale(1);   opacity: 1; }
              100% { transform: scale(0.7); opacity: 0; }
            }
          `}</style>
          </div>,
          document.body,
        )}
      {setupOpen &&
        createPortal(
          <RecordSetupModal
            initialOpts={opts}
            onSave={async (confirmedOpts, sourceId) => {
              setOpts(() => confirmedOpts)
              if (sourceId && IS_ELECTRON) {
                await window?.electronAPI?.desktop.setSource(sourceId)
              }
              setSetupOpen(false)
            }}
            onCancel={() => setSetupOpen(false)}
          />,
          document.body,
        )}
    </header>
  )
}

function ToggleChip({
  active,
  onClick,
  icon,
  label,
  disabled,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  disabled?: boolean
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={
        (active ? 'chip-on' : 'chip-off') +
        (disabled ? ' opacity-50 cursor-not-allowed' : '')
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
