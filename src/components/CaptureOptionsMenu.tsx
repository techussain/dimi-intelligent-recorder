import { useEffect, useRef, useState } from 'react'
import { Settings2, Mic, Camera, RefreshCw } from 'lucide-react'
import {
  primeDevicePermissions,
  useDevices,
  type MediaDeviceLite,
} from '../lib/capture/devices'

export interface CaptureDeviceSettings {
  micDeviceId?: string | undefined
  webcamDeviceId?: string | undefined
}

export interface CaptureOptionsMenuProps {
  value: CaptureDeviceSettings
  onChange: (v: CaptureDeviceSettings) => void
  disabled?: boolean
}

export function CaptureOptionsMenu({
  value,
  onChange,
  disabled,
}: CaptureOptionsMenuProps) {
  const [open, setOpen] = useState(false)
  const { mics, cams, refresh } = useDevices()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [priming, setPriming] = useState<null | 'audio' | 'video' | 'both'>(null)
  const primedRef = useRef(false)

  useEffect(() => {
    if (!open) return
    // Auto-prime device permissions the first time the menu opens so the
    // dropdowns show real device names instead of an empty list.
    if (!primedRef.current) {
      primedRef.current = true
      void (async () => {
        setPriming('both')
        try {
          await primeDevicePermissions('audio')
          await primeDevicePermissions('video')
          await refresh()
        } finally {
          setPriming(null)
        }
      })()
    }
    const onDown = (e: MouseEvent) => {
      // While a permission prompt is up, the OS/browser dialog can swallow
      // focus and the closing click may land on the page; ignore it so the
      // menu doesn't snap shut.
      if (priming) return
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, refresh, priming])

  return (
    <div ref={wrapRef} className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={
          'btn-ghost !px-2 ' + (disabled ? 'opacity-40 cursor-not-allowed' : '')
        }
        title="Capture settings"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Settings2 size={14} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[260px] z-40
            panel shadow-pop p-2 space-y-2"
          role="menu"
        >
          <div className="flex items-center justify-between px-1 pt-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Devices
            </span>
            <button
              onClick={() => {
                void (async () => {
                  setPriming('both')
                  try {
                    await primeDevicePermissions('audio')
                    await primeDevicePermissions('video')
                    await refresh()
                  } finally {
                    setPriming(null)
                  }
                })()
              }}
              className="btn-ghost !px-1.5 !py-0.5"
              title="Refresh devices"
            >
              <RefreshCw size={11} className={priming ? 'animate-spin' : ''} />
            </button>
          </div>

          <DeviceGroup
            icon={<Mic size={12} />}
            label="Microphone"
            devices={mics}
            value={value.micDeviceId}
            loading={priming === 'audio' || priming === 'both'}
            onChange={(id) => onChange({ ...value, micDeviceId: id })}
          />
          <DeviceGroup
            icon={<Camera size={12} />}
            label="Webcam"
            devices={cams}
            value={value.webcamDeviceId}
            loading={priming === 'video' || priming === 'both'}
            onChange={(id) => onChange({ ...value, webcamDeviceId: id })}
          />
        </div>
      )}
    </div>
  )
}

function DeviceGroup({
  icon,
  label,
  devices,
  value,
  loading,
  onChange,
}: {
  icon: React.ReactNode
  label: string
  devices: MediaDeviceLite[]
  value?: string | undefined
  loading?: boolean
  onChange: (id: string | undefined) => void
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 px-1 pb-1 text-[11px] text-muted">
        {icon} {label}
        {loading && <span className="opacity-60">· loading…</span>}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={loading}
        className="w-full bg-surface2 border border-bd rounded-md px-2 py-1.5
          text-xs outline-none hover:border-bd2 focus:border-accent
          disabled:opacity-60"
      >
        <option value="">System default</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
        {!loading && devices.length === 0 && (
          <option value="" disabled>
            No devices found — grant permission
          </option>
        )}
      </select>
    </label>
  )
}
