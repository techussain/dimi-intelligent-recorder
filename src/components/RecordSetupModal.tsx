import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Monitor,
  Camera,
  Mic,
  Volume2,
  X,
  RefreshCw,
  Crop,
  Trash2,
  Check,
} from 'lucide-react'
import type { CaptureOptions } from '../lib/capture/captureManager'
import type { DesktopSourceInfo } from '../electron.d'
import { IS_ELECTRON } from '../lib/capabilities'
import { useFocusTrap } from '../lib/ui/useFocusTrap'

interface Props {
  initialOpts: CaptureOptions
  onSave: (opts: CaptureOptions, sourceId?: string) => void | Promise<void>
  onCancel: () => void
}

type CropRegion = NonNullable<CaptureOptions['cropRegion']>

export function RecordSetupModal({ initialOpts, onSave, onCancel }: Props) {
  const isElectron = IS_ELECTRON
  const [opts, setOpts] = useState<CaptureOptions>(initialOpts)
  const [sources, setSources] = useState<DesktopSourceInfo[]>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [cropRegion, setCropRegion] = useState<CropRegion | null>(null)
  const [loading, setLoading] = useState(false)
  const loadedRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)

  // Load capturable sources once when screen is enabled (Electron only)
  useEffect(() => {
    if (!isElectron || !opts.screen) return
    if (loadedRef.current) return
    loadedRef.current = true
    setLoading(true)
    window
      .electronAPI!.desktop.getSources()
      .then((srcs) => {
        setSources(srcs)
        // Auto-select the first full-screen source
        const first = srcs.find((s) => s.id.startsWith('screen:')) ?? srcs[0]
        if (first) setSelectedSource(first.id)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [isElectron, opts.screen])

  function refreshSources() {
    if (!isElectron) return
    setLoading(true)
    window
      .electronAPI!.desktop.getSources()
      .then((srcs) => {
        setSources(srcs)
        if (srcs.length > 0 && !srcs.find((s) => s.id === selectedSource)) {
          const first = srcs.find((s) => s.id.startsWith('screen:')) ?? srcs[0]
          if (first) setSelectedSource(first.id)
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const nothingSelected = !opts.screen && !opts.mic && !opts.webcam
  const screenNeedsSource = opts.screen && isElectron && !selectedSource && !loading

  function handleSave() {
    void onSave(
      { ...opts, cropRegion: cropRegion ?? null },
      selectedSource ?? undefined,
    )
  }

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        className="bg-surface border border-bd rounded-xl shadow-pop w-[680px] max-h-[88vh] flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Recording setup"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-bd shrink-0">
          <h2 className="text-sm font-semibold">What do you want to record?</h2>
          <button onClick={onCancel} className="btn-ghost !px-2" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {/* Source type cards */}
          <div className="grid grid-cols-2 gap-3">
            <SourceCard
              icon={<Monitor size={20} />}
              label="Screen / Window"
              description="Capture a screen or app window"
              active={opts.screen}
              onClick={() => setOpts((o) => ({ ...o, screen: !o.screen }))}
            />
            <SourceCard
              icon={<Camera size={20} />}
              label="Webcam"
              description="Record from your camera"
              active={opts.webcam}
              onClick={() => setOpts((o) => ({ ...o, webcam: !o.webcam }))}
            />
            <SourceCard
              icon={<Mic size={20} />}
              label="Microphone"
              description="Record your voice"
              active={opts.mic}
              onClick={() => setOpts((o) => ({ ...o, mic: !o.mic }))}
            />
            <SourceCard
              icon={<Volume2 size={20} />}
              label="System Audio"
              description="Capture computer sound output"
              active={opts.systemAudio}
              onClick={() => setOpts((o) => ({ ...o, systemAudio: !o.systemAudio }))}
            />
          </div>

          {/* Screen / window source picker — Electron only */}
          {opts.screen && isElectron && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                  Select screen or window
                </span>
                <button
                  onClick={refreshSources}
                  disabled={loading}
                  className="btn-ghost !px-1.5 !py-1"
                  title="Refresh source list"
                >
                  <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>

              {loading ? (
                <div className="text-xs text-muted text-center py-6">
                  Loading sources…
                </div>
              ) : sources.length === 0 ? (
                <div className="text-xs text-muted text-center py-6">
                  No sources found. Click refresh to try again.
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2 max-h-52 overflow-y-auto pr-0.5">
                  {sources.map((src) => (
                    <button
                      key={src.id}
                      onClick={() => {
                        setSelectedSource(src.id)
                        setCropRegion(null)
                      }}
                      className={
                        'rounded-md overflow-hidden border-2 text-left transition-all flex-col ' +
                        (selectedSource === src.id
                          ? 'border-accent ring-1 ring-accent/40'
                          : 'border-bd hover:border-bd2')
                      }
                    >
                      <div className="relative bg-black aspect-video overflow-hidden">
                        <img
                          src={src.thumbnail}
                          alt={src.name}
                          className="w-full h-full object-cover"
                        />
                        {selectedSource === src.id && (
                          <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-accent flex items-center justify-center shadow">
                            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                              <path
                                d="M1 4L3.5 6.5L7 2"
                                stroke="white"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div className="px-2 py-1 bg-elevated flex items-center gap-1.5">
                        {src.appIcon && (
                          <img
                            src={src.appIcon}
                            alt=""
                            className="w-3 h-3 object-contain shrink-0"
                          />
                        )}
                        <span className="text-[10px] truncate text-fg/80">
                          {src.name}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Region picker — shown after a source is selected */}
          {opts.screen &&
            isElectron &&
            selectedSource &&
            !loading &&
            (() => {
              const src = sources.find((s) => s.id === selectedSource)
              return src ? (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted flex items-center gap-1.5">
                      <Crop size={11} /> Capture Region
                    </span>
                    {cropRegion && (
                      <button
                        className="btn-ghost !px-1.5 !py-1 text-[11px] flex items-center gap-1"
                        onClick={() => setCropRegion(null)}
                      >
                        <Trash2 size={10} /> Clear (full source)
                      </button>
                    )}
                  </div>
                  <RegionPicker
                    thumbnail={src.thumbnail}
                    value={cropRegion}
                    onChange={setCropRegion}
                  />
                  <p className="text-[10px] text-muted mt-1.5">
                    {cropRegion
                      ? `Region: ${Math.round(cropRegion.widthRatio * 100)}\u202f×\u202f${Math.round(cropRegion.heightRatio * 100)}\u202f% of source — drag again to redraw`
                      : 'Drag on the preview to select a region, or leave empty to record the full source.'}
                  </p>
                </div>
              ) : null
            })()}

          {/* Browser hint for screen capture */}
          {opts.screen && !isElectron && (
            <p className="text-[11px] text-muted bg-white/5 rounded-md px-3 py-2">
              Your browser will show its own screen / window picker when recording
              starts.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-bd shrink-0">
          <p className="text-[11px] text-muted">
            {nothingSelected
              ? 'Select at least one source to record.'
              : `Recording: ${[
                  opts.screen && 'Screen',
                  opts.webcam && 'Webcam',
                  opts.mic && 'Mic',
                  opts.systemAudio && 'System Audio',
                ]
                  .filter(Boolean)
                  .join(', ')}`}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onCancel} className="btn-soft">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={nothingSelected || screenNeedsSource}
              className="btn-primary gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={13} />
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

function RegionPicker({
  thumbnail,
  value,
  onChange,
}: {
  thumbnail: string
  value: CropRegion | null
  onChange: (r: CropRegion | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{
    x0: number
    y0: number
    x1: number
    y1: number
  } | null>(null)

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const rect = containerRef.current!.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    setDrag({ x0: x, y0: y, x1: x, y1: y })
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const rect = containerRef.current!.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    setDrag((d) => (d ? { ...d, x1: x, y1: y } : null))
  }

  function onPointerUp() {
    if (!drag) return
    const { x0, y0, x1, y1 } = drag
    setDrag(null)
    const xRatio = Math.min(x0, x1)
    const yRatio = Math.min(y0, y1)
    const widthRatio = Math.abs(x1 - x0)
    const heightRatio = Math.abs(y1 - y0)
    if (widthRatio < 0.02 || heightRatio < 0.02) {
      onChange(null)
      return
    }
    onChange({ xRatio, yRatio, widthRatio, heightRatio })
  }

  const sel = drag
    ? {
        xRatio: Math.min(drag.x0, drag.x1),
        yRatio: Math.min(drag.y0, drag.y1),
        widthRatio: Math.abs(drag.x1 - drag.x0),
        heightRatio: Math.abs(drag.y1 - drag.y0),
      }
    : value

  return (
    <div
      ref={containerRef}
      className="relative rounded-md overflow-hidden cursor-crosshair select-none bg-black"
      style={{ aspectRatio: '16/9' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <img
        src={thumbnail}
        alt=""
        className="w-full h-full object-cover pointer-events-none"
      />
      {sel ? (
        <div
          className="absolute pointer-events-none border-2 border-accent"
          style={{
            left: `${sel.xRatio * 100}%`,
            top: `${sel.yRatio * 100}%`,
            width: `${sel.widthRatio * 100}%`,
            height: `${sel.heightRatio * 100}%`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="bg-black/60 text-white/60 text-[10px] px-2 py-1 rounded">
            Drag to select a region
          </span>
        </div>
      )}
    </div>
  )
}

function SourceCard({
  icon,
  label,
  description,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  description: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={
        'flex items-start gap-3 p-3.5 rounded-lg border-2 text-left transition-all ' +
        (active
          ? 'border-accent bg-accent/10'
          : 'border-bd bg-elevated hover:border-bd2 hover:bg-white/[0.03]')
      }
    >
      <div
        className={
          'mt-0.5 rounded-md p-2 shrink-0 ' +
          (active ? 'bg-accent/20 text-accent-text' : 'bg-white/5 text-muted')
        }
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted mt-0.5 leading-snug">{description}</div>
      </div>
      {active && (
        <div className="mt-0.5 w-4 h-4 rounded-full bg-accent flex items-center justify-center shrink-0">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path
              d="M1 4L3.5 6.5L7 2"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
    </button>
  )
}
