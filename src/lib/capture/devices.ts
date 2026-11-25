import { useEffect, useState, useCallback } from 'react'
import { isStaleDeviceError } from './webcam'

export interface MediaDeviceLite {
  deviceId: string
  label: string
  kind: MediaDeviceKind
  groupId: string
}

/** Ensure we have permission so enumerateDevices returns labels. */
export async function primeDevicePermissions(kind: 'audio' | 'video'): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'audio' ? { audio: true } : { video: true },
    )
    stream.getTracks().forEach((t) => t.stop())
  } catch {
    /* user denied — we'll still show unlabeled devices */
  }
}

export async function listDevices(): Promise<MediaDeviceLite[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.map((d) => ({
    deviceId: d.deviceId,
    label: d.label || fallbackLabel(d.kind, d.deviceId),
    kind: d.kind,
    groupId: d.groupId,
  }))
}

function fallbackLabel(kind: MediaDeviceKind, id: string): string {
  const short = id.slice(0, 6)
  switch (kind) {
    case 'audioinput':
      return `Microphone · ${short}`
    case 'videoinput':
      return `Camera · ${short}`
    case 'audiooutput':
      return `Speaker · ${short}`
    default:
      return `Device · ${short}`
  }
}

/** React hook returning a live list of devices (updates on devicechange). */
export function useDevices(): {
  mics: MediaDeviceLite[]
  cams: MediaDeviceLite[]
  refresh: () => Promise<void>
} {
  const [devices, setDevices] = useState<MediaDeviceLite[]>([])

  const refresh = useCallback(async () => {
    setDevices(await listDevices())
  }, [])

  useEffect(() => {
    void refresh()
    const handler = () => void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', handler)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handler)
    }
  }, [refresh])

  return {
    mics: devices.filter((d) => d.kind === 'audioinput'),
    cams: devices.filter((d) => d.kind === 'videoinput'),
    refresh,
  }
}

/**
 * Open the microphone. If the saved `deviceId` is stale, retries once with
 * the default input and calls `onStaleDevice` so the caller can forget it.
 */
export async function openMicStream(
  deviceId?: string,
  onStaleDevice?: () => void,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    })
  } catch (err) {
    if (!deviceId || !isStaleDeviceError(err)) throw err
    onStaleDevice?.()
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  }
}

/**
 * Which saved device ids no longer match a connected device. Returns nothing
 * for a kind whose ids are hidden (no permission yet → enumerateDevices gives
 * empty ids), so an unprimed list never wipes a valid choice.
 */
export async function findStaleDeviceIds(saved: {
  micDeviceId?: string | undefined
  webcamDeviceId?: string | undefined
}): Promise<{ mic: boolean; webcam: boolean }> {
  const all = await listDevices()
  const stale = (kind: MediaDeviceKind, id: string | undefined): boolean => {
    if (!id) return false
    const ids = all.filter((d) => d.kind === kind && d.deviceId).map((d) => d.deviceId)
    return ids.length > 0 && !ids.includes(id)
  }
  return {
    mic: stale('audioinput', saved.micDeviceId),
    webcam: stale('videoinput', saved.webcamDeviceId),
  }
}
