import { useEffect, useState } from 'react'
import { openWebcamStream } from './webcam'
import { useCaptureOpts } from '../ui/pipStore'

export interface WebcamPreview {
  stream: MediaStream | null
  error: Error | null
}

/**
 * Open a live webcam MediaStream while `active` is true.
 * Stops tracks when deactivated / deviceId changes / unmount.
 * If the track ends for any reason, re-acquires automatically.
 * Intentionally has NO page-visibility logic — the component is always
 * mounted (CSS-hidden when not needed), so the stream should never be
 * stopped by minimize/restore cycles.
 */
export function useWebcamPreview(active: boolean, deviceId?: string): WebcamPreview {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<Error | null>(null)
  // Bumping triggers a fresh acquire attempt (used when the track ends).
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (!active) {
      setStream(null)
      setError(null)
      return
    }

    let cancelled = false
    let acquired: MediaStream | null = null
    setError(null)

    void (async () => {
      try {
        // A stale saved camera falls back to the default one.
        let stale = false
        const s = await openWebcamStream(deviceId, () => {
          stale = true
        })
        if (stale && !cancelled) {
          // Forget the stale id. This re-runs the effect (deviceId → default),
          // so drop this stream and let the next run open the camera.
          s.getTracks().forEach((t) => t.stop())
          useCaptureOpts.getState().patchOpts({ webcamDeviceId: undefined })
          return
        }
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        acquired = s
        setStream(s)

        // If the track ends for any reason, queue a re-acquire.
        // Calling track.stop() in the cleanup below also triggers 'ended',
        // but `cancelled` will be true by then so it's a no-op.
        s.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (cancelled) return
          setStream(null)
          setRetryCount((n) => n + 1)
        })
      } catch (err) {
        if (cancelled) return
        setError(err as Error)
        setStream(null)
      }
    })()

    return () => {
      cancelled = true
      acquired?.getTracks().forEach((t) => t.stop())
    }
  }, [active, deviceId, retryCount])

  return { stream, error }
}
