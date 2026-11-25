import { useEffect, useState } from 'react'
import { getPoster, getThumbnails } from './thumbnails'
import type { MediaSource } from '../timeline/types'
import { getWaveformPeaks } from './waveforms'

export function useThumbnails(
  sourceId: string | null,
  opfsPath: string | null,
  duration: number,
): string[] | null {
  const [thumbs, setThumbs] = useState<string[] | null>(null)

  useEffect(() => {
    if (!sourceId || !opfsPath) return
    let cancelled = false
    const r = getThumbnails(sourceId, opfsPath, duration)
    if (Array.isArray(r)) {
      setThumbs(r)
      return
    }
    r.then((t) => {
      if (!cancelled) setThumbs(t)
    }).catch(() => {
      /* ignore */
    })
    return () => {
      cancelled = true
    }
  }, [sourceId, opfsPath, duration])

  return thumbs
}

/** A poster frame for an animation / element source (null while loading). */
export function usePoster(source: MediaSource | null): string | null {
  const [poster, setPoster] = useState<string | null>(null)
  // Re-render when the visible content changes (element params, replaced file).
  const key = source
    ? `${source.id}|${source.opfsPath}|${JSON.stringify(source.element ?? null)}`
    : null

  useEffect(() => {
    if (!source) return
    let cancelled = false
    const r = getPoster(source)
    if (typeof r === 'string') {
      setPoster(r)
      return
    }
    r.then((p) => {
      if (!cancelled) setPoster(p)
    }).catch(() => {
      /* ignore */
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return source ? poster : null
}

export function useWaveform(
  sourceId: string | null,
  opfsPath: string | null,
): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null)

  useEffect(() => {
    if (!sourceId || !opfsPath) return
    let cancelled = false
    const r = getWaveformPeaks(sourceId, opfsPath)
    if (r instanceof Float32Array) {
      setPeaks(r)
      return
    }
    r.then((p) => {
      if (!cancelled) setPeaks(p)
    }).catch(() => {
      /* ignore */
    })
    return () => {
      cancelled = true
    }
  }, [sourceId, opfsPath])

  return peaks
}
