import type { Project } from '../timeline/types'
import { getBlobUrl, releaseBlobUrl } from '../storage/blobCache'
import { readFile } from '../storage/opfs'
import { getLiveStream } from '../capture/liveStreams'
import { LRUCache } from '../media/lru'
import {
  buildScene,
  drawScene,
  fitView,
  mediaSize,
  type DrawSceneOptions,
  type SceneImage,
  type SceneLayer,
} from './scene'
import { ProviderPool, animationFrameTime } from './providers/pool'
import { createProviderFromFile } from './providers/forSource'
import type { FrameProvider } from './providers/types'
import { createChromaKeyProcessor, colorAt, suggestKeyColor } from './chromaKey'
import type { ChromaKeyProcessor } from './chromaKey'
import { chromaProcessImage } from './chromaLayer'

export { findActiveClip } from './scene'

// Maximum number of HTMLVideoElement decode handles to keep alive at once.
// Eviction releases the GPU decode pipeline for the oldest unused source.
const VIDEO_POOL_SIZE = 10
/** Decoded still images kept; a long tutorial can show hundreds of them. */
const IMAGE_POOL_SIZE = 40

// After a seek, a video may not have a decoded frame yet. Rather than
// flashing black, keep the previous composite on screen for up to this long.
const STALE_HOLD_MS = 500

// Animation providers not on screen that stay loaded (scrubbing back is instant).
const IDLE_PROVIDERS = 6

let activeEngine: PreviewEngine | null = null

/** The preview engine currently attached to the editor's preview canvas. */
export function activePreviewEngine(): PreviewEngine | null {
  return activeEngine
}

/**
 * Minimal preview engine. Uses a pool of HTMLVideoElements + a 2D canvas
 * composite. Which clips are drawn and how (transitions, transforms) is
 * decided by compositor/scene.ts, shared with the exporter.
 *
 * Live (still-recording) clips are drawn from the capture MediaStream
 * (capture/liveStreams.ts): an element pointed at the OPFS file can't see
 * data appended after it loaded.
 *
 * Limitations (known, acceptable for MVP):
 *  - Seeking in WebM recorded without cues can be jittery.
 */

interface VideoEntry {
  el: HTMLVideoElement
  url: string
  opfsPath: string
  ready: boolean
}

interface ImageEntry {
  el: HTMLImageElement
  url: string
  opfsPath: string
  ready: boolean
}

interface LiveEntry {
  el: HTMLVideoElement
  stream: MediaStream
}

type RenderArgs = { project: Project; t: number; playing: boolean }

export class PreviewEngine {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  // LRU pool — evicted entries have their video element released so
  // the GPU decode pipeline for that source is freed. Keyed by
  // SceneLayer.key (sourceId, or clip id when a source is shown twice).
  // Evicted / replaced / disposed entries also give back their blob-URL
  // reference, so the object URL is revoked once nothing uses it.
  private videos = new LRUCache<string, VideoEntry>(VIDEO_POOL_SIZE, (_id, entry) => {
    entry.el.pause()
    entry.el.removeAttribute('src')
    entry.el.load()
    releaseBlobUrl(entry.opfsPath, entry.url)
  })
  // Bounded too: every image ever shown used to stay decoded until dispose.
  private images = new LRUCache<string, ImageEntry>(IMAGE_POOL_SIZE, (_id, entry) => {
    entry.el.removeAttribute('src')
    releaseBlobUrl(entry.opfsPath, entry.url)
  }) // keyed by sourceId
  private live = new Map<string, LiveEntry>() // keyed by sourceId
  private width = 1920
  private height = 1080
  private renderInFlight = false
  private pending: RenderArgs | null = null
  private last: RenderArgs | null = null
  private lastDrawAt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private drawOpts: DrawSceneOptions = {}
  // Animated sources (Lottie / GIF …), keyed by SceneLayer.key. A provider
  // that becomes ready or receives a missing frame repaints the last frame.
  private providers = new ProviderPool(
    async (source) => createProviderFromFile(source, await readFile(source.opfsPath)),
    () => this.onProviderUpdate(),
  )
  private providerRepaintQueued = false
  private chroma: ChromaKeyProcessor | null = null
  private readonly processImage = chromaProcessImage(() => {
    if (this.disposed) return null
    this.chroma ??= createChromaKeyProcessor()
    return this.chroma
  })
  /** Unprocessed image last drawn per clip id (eyedropper / auto key colour). */
  private lastRaw = new Map<string, SceneImage>()

  /** `width`/`height` are the PROJECT size; call `resize` with the displayed size. */
  attach(canvas: HTMLCanvasElement, width: number, height: number): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- registry of the live engine
    activeEngine = this
    this.width = width
    this.height = height
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    const rect = canvas.getBoundingClientRect()
    this.resize(
      rect.width || width,
      rect.height || height,
      window.devicePixelRatio || 1,
    )
  }

  /**
   * Size the backing store to the displayed CSS size × DPR, capped at the
   * project resolution (a 900px pane doesn't need a 4K canvas).
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const canvas = this.canvas
    if (!canvas || cssWidth <= 0 || cssHeight <= 0) return
    const scale = Math.min(
      1,
      (cssWidth * dpr) / this.width,
      (cssHeight * dpr) / this.height,
    )
    const w = Math.max(1, Math.round(this.width * scale))
    const h = Math.max(1, Math.round(this.height * scale))
    if (canvas.width === w && canvas.height === h) return
    canvas.width = w
    canvas.height = h
    // Resizing clears the canvas — repaint the last frame right away.
    this.lastDrawAt = 0
    if (this.last) void this.render(this.last.project, this.last.t, this.last.playing)
  }

  /**
   * Options passed to every drawScene call (e.g. `suppressEffects` while a
   * zoom focus is being picked). Repaints the last frame when they change.
   */
  setDrawOptions(opts: DrawSceneOptions): void {
    const prev = this.drawOpts
    if (
      prev.suppressEffects === opts.suppressEffects &&
      prev.processImage === opts.processImage &&
      prev.cropGhost === opts.cropGhost
    )
      return
    this.drawOpts = { ...opts }
    this.lastDrawAt = 0
    if (this.last) void this.render(this.last.project, this.last.t, this.last.playing)
  }

  async ensureSource(key: string, opfsPath: string): Promise<VideoEntry> {
    const existing = this.videos.get(key)
    if (existing && existing.opfsPath === opfsPath) return existing
    // Same key, new file (e.g. remuxed recording): release the old element.
    if (existing) this.videos.delete(key)

    const el = document.createElement('video')
    el.muted = true // audio is mixed separately via Web Audio
    el.playsInline = true
    el.preload = 'auto'
    el.preservesPitch = true
    const url = await getBlobUrl(opfsPath)
    if (this.disposed) {
      releaseBlobUrl(opfsPath, url)
      throw new Error('PreviewEngine disposed')
    }
    // A concurrent call loaded the same file meanwhile: use that one.
    const raced = this.videos.get(key)
    if (raced?.opfsPath === opfsPath) {
      releaseBlobUrl(opfsPath, url)
      return raced
    }
    if (raced) this.videos.delete(key)
    el.src = url
    const entry: VideoEntry = { el, url, opfsPath, ready: false }
    el.addEventListener('loadeddata', () => {
      entry.ready = true
    })
    this.videos.set(key, entry)
    return entry
  }

  async ensureImageSource(sourceId: string, opfsPath: string): Promise<ImageEntry> {
    const existing = this.images.get(sourceId)
    if (existing && existing.opfsPath === opfsPath) return existing
    if (existing) this.images.delete(sourceId)

    const el = new Image()
    const url = await getBlobUrl(opfsPath)
    if (this.disposed) {
      releaseBlobUrl(opfsPath, url)
      throw new Error('PreviewEngine disposed')
    }
    const raced = this.images.get(sourceId)
    if (raced?.opfsPath === opfsPath) {
      releaseBlobUrl(opfsPath, url)
      return raced
    }
    if (raced) this.images.delete(sourceId)
    const entry: ImageEntry = { el, url, opfsPath, ready: false }
    el.addEventListener('load', () => {
      entry.ready = true
    })
    el.src = url
    if (el.complete && el.naturalWidth > 0) entry.ready = true
    this.images.set(sourceId, entry)
    return entry
  }

  /** A muted <video> playing the capture stream for a live source, if registered. */
  private ensureLive(sourceId: string): HTMLVideoElement | null {
    const stream = getLiveStream(sourceId)
    const existing = this.live.get(sourceId)
    if (existing && existing.stream === stream) return existing.el
    if (existing) this.releaseLive(sourceId)
    if (!stream || this.disposed) return null
    const el = document.createElement('video')
    el.muted = true // never play live audio (feedback risk)
    el.playsInline = true
    el.autoplay = true
    el.srcObject = stream
    void el.play().catch(() => {
      /* autoplay policy — muted playback is normally allowed */
    })
    this.live.set(sourceId, { el, stream })
    return el
  }

  private releaseLive(sourceId: string): void {
    const entry = this.live.get(sourceId)
    if (!entry) return
    entry.el.pause()
    entry.el.srcObject = null
    this.live.delete(sourceId)
  }

  /**
   * Render a single frame at the given master timeline time. `playing`
   * controls whether underlying <video> elements should be playing (so audio
   * sync + frame advance tracks the clock) vs. paused-and-seeked (scrubbing).
   *
   * Non-reentrant: if a render is already in flight, the newest request is
   * queued and the previous pending request is discarded. This prevents
   * concurrent renders from clearing each other's canvas during fast updates
   * (e.g. dragging transform handles).
   */
  async render(project: Project, t: number, playing: boolean): Promise<void> {
    this.last = { project, t, playing }
    if (this.renderInFlight) {
      this.pending = { project, t, playing }
      return
    }
    this.renderInFlight = true
    try {
      await this.renderInternal(project, t, playing)
    } finally {
      this.renderInFlight = false
    }
    if (this.pending) {
      const next = this.pending
      this.pending = null
      void this.render(next.project, next.t, next.playing)
    }
  }

  private async renderInternal(
    project: Project,
    t: number,
    playing: boolean,
  ): Promise<void> {
    const ctx = this.ctx
    const canvas = this.canvas
    if (!ctx || !canvas || this.disposed) return

    const scene = buildScene(project, t, { includeLive: true })
    const images = new Map<SceneLayer, SceneImage>()
    const animations = new Map<SceneLayer, FrameProvider>()
    const activeKeys = new Set<string>()
    const providerKeys = new Set<string>()
    const liveIds = new Set<string>()
    let stale = false
    // An animation still loading: hold the previous composite like a seeking
    // video, but don't poll — the provider pool repaints once it is ready.
    let waitingForProvider = false

    for (const group of scene) {
      for (const layer of group.layers) {
        const { clip, source } = layer
        // A single unreadable/missing OPFS source (deleted media, a bundle that
        // omitted a file, post-crash state) must NOT blank the whole frame.
        // Isolate each clip so one failing load only drops that clip.
        try {
          if (source.kind === 'animation') {
            providerKeys.add(layer.key)
            const provider = this.providers.get(layer.key, source)
            if (provider) animations.set(layer, provider)
            else if (!this.providers.failed(layer.key)) waitingForProvider = true
            continue
          }
          if (source.kind === 'image') {
            const entry = await this.ensureImageSource(source.id, source.opfsPath)
            if (entry.ready) images.set(layer, entry.el)
            else stale = true
            continue
          }
          if (source.kind !== 'video') continue

          if (layer.live) {
            liveIds.add(source.id)
            const el = this.ensureLive(source.id)
            if (el && el.readyState >= 2) images.set(layer, el)
            else stale = true
            continue
          }

          activeKeys.add(layer.key)
          const entry = await this.ensureSource(layer.key, source.opfsPath)
          const rate = Math.max(0.0625, Math.min(16, clip.speed || 1))
          if (entry.el.playbackRate !== rate) entry.el.playbackRate = rate
          // While a transition holds the first/last frame, never call play() —
          // the element would run past the trim (or fire 'ended' and restart).
          await this.syncVideo(
            entry.el,
            layer.sourceTime,
            layer.holding ? false : playing,
          )
          if (entry.el.readyState < 2) {
            stale = true
            continue
          }
          images.set(layer, entry.el)
        } catch {
          // Skip just this clip; keep compositing the rest of the frame.
        }
      }
    }

    if (this.disposed) return
    for (const [key, entry] of this.videos.entries()) {
      if (!activeKeys.has(key) && !entry.el.paused) entry.el.pause()
    }
    for (const id of [...this.live.keys()]) {
      if (!liveIds.has(id)) this.releaseLive(id)
    }
    this.providers.retain(providerKeys, IDLE_PROVIDERS)

    // A layer without a decoded frame yet (just seeked): keep the previous
    // composite instead of flashing black, and retry shortly when paused.
    if (
      (stale || waitingForProvider) &&
      this.lastDrawAt > 0 &&
      performance.now() - this.lastDrawAt < STALE_HOLD_MS
    ) {
      if (stale && !playing) this.scheduleRetry()
      return
    }

    this.lastRaw.clear()
    drawScene(
      ctx,
      project,
      t,
      scene,
      (layer) => {
        // Animation frames are produced right before they are drawn: a
        // provider may reuse one canvas for every frame it hands out.
        const provider = animations.get(layer)
        let el: SceneImage | null
        if (provider) {
          const at = animationFrameTime(layer.clip, layer.sourceTime)
          el = (provider.frameAt(at.t, at.loop) as SceneImage | null) ?? null
        } else {
          el = images.get(layer) ?? null
        }
        if (el) this.lastRaw.set(layer.clip.id, el)
        return el
      },
      fitView(this.width, this.height, canvas.width, canvas.height),
      { ...this.drawOpts, processImage: this.processImage },
    )
    this.lastDrawAt = performance.now()
    if (stale && !playing) this.scheduleRetry()
  }

  /** A provider got ready / received a missing frame: repaint (coalesced). */
  private onProviderUpdate(): void {
    if (this.disposed || this.providerRepaintQueued) return
    this.providerRepaintQueued = true
    queueMicrotask(() => {
      this.providerRepaintQueued = false
      const last = this.last
      // While playing, the playback loop renders every frame anyway.
      if (!last || last.playing || this.disposed) return
      this.lastDrawAt = 0
      void this.render(last.project, last.t, false)
    })
  }

  /**
   * Eyedropper: colour of the clip's unkeyed frame (as last drawn) at
   * source-normalized (u, v). Null when the clip isn't on screen.
   */
  pickColor(clipId: string, u: number, v: number): string | null {
    const el = this.lastRaw.get(clipId)
    return el ? colorAt(el, u, v) : null
  }

  /** Suggested key colour from the clip's current (unkeyed) frame border. */
  suggestColor(clipId: string): string | null {
    const el = this.lastRaw.get(clipId)
    if (!el) return null
    const { w, h } = mediaSize(el)
    if (!w || !h) return null
    return suggestKeyColor(el, w, h)
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.last && !this.last.playing) {
        void this.render(this.last.project, this.last.t, false)
      }
    }, 100)
  }

  private async syncVideo(
    el: HTMLVideoElement,
    targetSec: number,
    playing: boolean,
  ): Promise<void> {
    if (!Number.isFinite(targetSec)) return
    const drift = Math.abs(el.currentTime - targetSec)
    if (playing) {
      if (drift > 0.25) el.currentTime = Math.max(0, targetSec)
      if (el.paused) {
        try {
          await el.play()
        } catch {
          // autoplay policy — caller must initiate via user gesture
        }
      }
    } else {
      if (!el.paused) el.pause()
      if (drift > 0.03) {
        el.currentTime = Math.max(0, targetSec)
        // Wait for the browser to decode the frame at the new position.
        // Without this, drawing runs immediately after the seek is *requested*
        // but before the frame is ready (readyState < 2).
        await new Promise<void>((resolve) => {
          // eslint-disable-next-line prefer-const
          let timer: ReturnType<typeof setTimeout>
          const done = () => {
            clearTimeout(timer)
            el.removeEventListener('seeked', done)
            el.removeEventListener('error', done)
            resolve()
          }
          el.addEventListener('seeked', done, { once: true })
          el.addEventListener('error', done, { once: true })
          // Safety timeout: if seeked never fires (e.g. WebM without cue table),
          // draw whatever the browser has rather than blocking forever.
          timer = setTimeout(done, 400)
        })
      }
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.last = null
    this.pending = null
    this.videos.clear() // onEvict pauses, clears src and releases each URL
    this.images.clear()
    for (const id of [...this.live.keys()]) this.releaseLive(id)
    this.providers.dispose()
    this.lastRaw.clear()
    this.chroma?.dispose()
    this.chroma = null
    if (activeEngine === this) activeEngine = null
  }
}
