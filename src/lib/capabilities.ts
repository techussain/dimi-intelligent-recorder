/**
 * Detects required browser capabilities. The editor requires WebCodecs + OPFS
 * + getDisplayMedia; today that effectively means a recent Chromium browser.
 */
export interface Capability {
  id: string
  label: string
  ok: boolean
  detail?: string
}

export function detectCapabilities(): Capability[] {
  const caps: Capability[] = []

  caps.push({
    id: 'webcodecs',
    label: 'WebCodecs (VideoEncoder/Decoder)',
    ok:
      typeof (globalThis as unknown as { VideoEncoder?: unknown }).VideoEncoder !==
        'undefined' &&
      typeof (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder !==
        'undefined',
  })

  caps.push({
    id: 'audiocodecs',
    label: 'Audio codecs (AudioEncoder/Decoder)',
    ok:
      typeof (globalThis as unknown as { AudioEncoder?: unknown }).AudioEncoder !==
        'undefined' &&
      typeof (globalThis as unknown as { AudioDecoder?: unknown }).AudioDecoder !==
        'undefined',
  })

  const hasGDM =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  caps.push({
    id: 'getDisplayMedia',
    label: 'Screen capture (getDisplayMedia)',
    ok: hasGDM,
  })

  const hasGUM =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  caps.push({
    id: 'getUserMedia',
    label: 'Mic/camera capture (getUserMedia)',
    ok: hasGUM,
  })

  const hasMR = typeof window !== 'undefined' && 'MediaRecorder' in window
  caps.push({
    id: 'mediaRecorder',
    label: 'MediaRecorder',
    ok: hasMR,
  })

  const hasOPFS =
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  caps.push({
    id: 'opfs',
    label: 'Origin Private File System',
    ok: hasOPFS,
  })

  caps.push({
    id: 'sab',
    label: 'SharedArrayBuffer (cross-origin isolated)',
    ok:
      typeof SharedArrayBuffer !== 'undefined' &&
      (globalThis as unknown as { crossOriginIsolated?: boolean })
        .crossOriginIsolated === true,
    detail: 'Requires COOP/COEP headers.',
  })

  // Centralise Electron detection so components use one canonical source
  // instead of scattering `window.electronAPI?.isElectron` checks.
  caps.push({
    id: 'electronShell',
    label: 'Electron shell',
    ok: typeof window !== 'undefined' && !!window.electronAPI?.isElectron,
  })

  return caps
}

/** Convenience helper — returns true when running inside Electron. */
export function isElectron(caps: Capability[]): boolean {
  return caps.find((c) => c.id === 'electronShell')?.ok ?? false
}

/**
 * Module-level constant: true when the app is running inside Electron.
 * Evaluated once at import time — the shell type cannot change during a session.
 * Components should import this instead of scattering `window.electronAPI?.isElectron`.
 */
export const IS_ELECTRON: boolean =
  typeof window !== 'undefined' && !!window.electronAPI?.isElectron

export function allRequiredOk(caps: Capability[]): boolean {
  // SAB and electronShell are optional/environmental, not hard requirements.
  return caps
    .filter((c) => c.id !== 'sab' && c.id !== 'electronShell')
    .every((c) => c.ok)
}
