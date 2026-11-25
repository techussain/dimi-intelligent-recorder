/**
 * Thumbnail strip generator.
 *
 * Generating thumbnails requires HTMLVideoElement (seek + drawImage), which is
 * only available on the main thread. A full VideoDecoder-based worker approach
 * would need a WebM/EBML demuxer that is not currently bundled. Instead, we:
 *   1. Yield the event loop between each seek+capture (one setTimeout(0) per
 *      frame) so no single generation blocks the UI for more than one frame.
 *   2. Store results in an LRU cache (max 100 entries) to bound memory usage.
 */
import { readFile } from '../storage/opfs'
import { LRUCache } from './lru'
import { elementParams } from '../compositor/scene'
import { createProviderFromFile } from '../compositor/providers/forSource'
import { drawElement, ELEMENT_FONT_FAMILY } from '../elements'
import { drawShape } from '../shapes'
import type { MediaSource } from '../timeline/types'

// LRU cache — frees dataURL strings for the oldest source when full.
interface ThumbEntry {
  thumbs: string[]
}
const cache = new LRUCache<string, ThumbEntry>(100)
const inFlight = new Map<string, Promise<string[]>>()

/** Target thumbnail height in device pixels (displayed proportionally). */
const THUMB_HEIGHT = 36
const THUMB_COUNT = 8

/** Yield the main-thread event loop once to allow rendering / input to proceed. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Per-step limits: a stalled load or seek fails instead of hanging forever. */
const LOAD_TIMEOUT_MS = 15_000
const SEEK_TIMEOUT_MS = 5_000

/**
 * Resolve on `okEvent`, reject on `error` or after `ms`. Listeners are always
 * removed, whichever way it settles.
 */
function waitFor(
  el: HTMLVideoElement,
  okEvent: string,
  ms: number,
  what: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      window.clearTimeout(timer)
      el.removeEventListener(okEvent, onOk)
      el.removeEventListener('error', onErr)
    }
    const onOk = () => {
      done()
      resolve()
    }
    const onErr = () => {
      done()
      reject(new Error(`Thumbnail ${what} failed`))
    }
    const timer = window.setTimeout(() => {
      done()
      reject(new Error(`Thumbnail ${what} timed out`))
    }, ms)
    el.addEventListener(okEvent, onOk)
    el.addEventListener('error', onErr)
  })
}

async function generate(opfsPath: string, duration: number): Promise<string[]> {
  const file = await readFile(opfsPath)
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  // Always release the element and blob URL — including on decode/seek
  // failure or timeout.
  try {
    const loaded = waitFor(video, 'loadeddata', LOAD_TIMEOUT_MS, 'decode')
    video.src = url
    await loaded

    const srcDur =
      isFinite(video.duration) && video.duration > 0 ? video.duration : duration
    const aspect = video.videoWidth / Math.max(1, video.videoHeight)
    const h = THUMB_HEIGHT
    const w = Math.max(24, Math.round(h * aspect))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Thumbnail canvas unavailable')

    const thumbs: string[] = []
    for (let i = 0; i < THUMB_COUNT; i++) {
      const t = ((i + 0.5) / THUMB_COUNT) * srcDur
      await seek(video, t, srcDur)
      ctx.drawImage(video, 0, 0, w, h)
      thumbs.push(canvas.toDataURL('image/jpeg', 0.6))
      // Yield to the event loop between each frame capture so we never
      // block the UI for more than one seek+drawImage task at a time.
      await yieldToEventLoop()
    }
    return thumbs
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

function seek(el: HTMLVideoElement, t: number, dur: number): Promise<void> {
  const target = Math.max(0, Math.min(t, dur - 0.01))
  if (Math.abs(el.currentTime - target) < 1e-3) return Promise.resolve()
  const seeked = waitFor(el, 'seeked', SEEK_TIMEOUT_MS, 'seek')
  el.currentTime = target
  return seeked
}

export function getThumbnails(
  sourceId: string,
  opfsPath: string,
  duration: number,
): string[] | Promise<string[]> {
  // Keyed by path too: a source whose file was swapped (remux) regenerates.
  const key = `${sourceId}|${opfsPath}`
  const cached = cache.get(key)
  if (cached) return cached.thumbs

  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = generate(opfsPath, duration)
    .then((thumbs) => {
      cache.set(key, { thumbs })
      inFlight.delete(key)
      return thumbs
    })
    .catch((err: unknown) => {
      // Cleared so a later call can retry.
      inFlight.delete(key)
      throw err
    })

  inFlight.set(key, promise)
  return promise
}

export function getThumbnailCount(): number {
  return THUMB_COUNT
}

// ── Animation / element posters ─────────────────────────────────────────────

const posterCache = new LRUCache<string, string>(100)
const posterInFlight = new Map<string, Promise<string>>()

/** Where in the clip the poster is taken (most animations are settled by then). */
const POSTER_AT = 0.45

async function renderPoster(source: MediaSource): Promise<string> {
  // Shapes: thin lines would make a very wide poster; keep it reasonable.
  const aspect = source.shape
    ? Math.min(
        8,
        Math.max(1 / 8, source.shape.width / Math.max(1, source.shape.height)),
      )
    : (source.width ?? 16) / Math.max(1, source.height ?? 9)
  const h = THUMB_HEIGHT * 2
  const w = Math.max(24, Math.round(h * aspect))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Thumbnail canvas unavailable')
  const at = Math.max(0, source.duration * POSTER_AT)
  if (source.kind === 'shape' && source.shape) {
    ctx.translate(w / 2, h / 2)
    drawShape(ctx, source.shape, { w: w * 0.9, h: h * 0.9 })
  } else if (source.kind === 'element' && source.element) {
    // Fonts first, or the poster would show fallback text.
    await document.fonts?.load(`700 24px ${ELEMENT_FONT_FAMILY}`).catch(() => [])
    ctx.translate(w / 2, h / 2)
    drawElement(
      ctx,
      source.element.template,
      elementParams(source),
      at,
      source.duration,
      { w, h },
    )
  } else {
    const provider = await createProviderFromFile(
      source,
      await readFile(source.opfsPath),
    )
    try {
      await provider.prepare(at, true)
      const frame = provider.frameAt(at, true)
      if (frame) ctx.drawImage(frame, 0, 0, w, h)
    } finally {
      provider.dispose()
    }
  }
  return canvas.toDataURL('image/png')
}

/** A small preview frame of an `animation`, `element` or `shape` source (data URL). */
export function getPoster(source: MediaSource): string | Promise<string> {
  const key = `${source.id}|${source.opfsPath}|${JSON.stringify(
    source.element ?? source.shape ?? null,
  )}`
  const cached = posterCache.get(key)
  if (cached) return cached
  const existing = posterInFlight.get(key)
  if (existing) return existing
  const promise = renderPoster(source)
    .then((url) => {
      posterCache.set(key, url)
      posterInFlight.delete(key)
      return url
    })
    .catch((err: unknown) => {
      posterInFlight.delete(key)
      throw err
    })
  posterInFlight.set(key, promise)
  return promise
}
