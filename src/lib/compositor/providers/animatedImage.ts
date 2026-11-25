/**
 * Animated GIF / WebP / APNG / AVIF via WebCodecs `ImageDecoder`.
 *
 * Frame delays follow browser behaviour (≤ 10 ms → 100 ms) so playback
 * matches what users see in a browser. Small animations are fully decoded
 * to ImageBitmaps up front (≤ 256 MB); bigger ones decode on demand into an
 * LRU with a short prefetch window ahead of the playhead. Every VideoFrame
 * the decoder hands out is closed immediately after conversion.
 */
import { LRUCache } from '../../media/lru'
import { readBlobBytes } from './readBlob'
import type { FrameProvider } from './types'

// ── Pure timing helpers (unit-tested) ───────────────────────────────────────

/** Delays at or below this are treated as "unspecified" by browsers… */
export const MIN_FRAME_DELAY_S = 0.01
/** …and replaced by this. */
export const DEFAULT_FRAME_DELAY_S = 0.1
/** Fully pre-decode when all frames fit in this many bytes (RGBA). */
export const PREDECODE_BUDGET_BYTES = 256 * 1024 * 1024
/** Memory for the on-demand LRU. */
export const ONDEMAND_BUDGET_BYTES = 64 * 1024 * 1024
/** Frames decoded ahead of the playhead in on-demand mode. */
export const PREFETCH_AHEAD = 6

/** Browser-compatible frame delay (seconds). */
export function clampFrameDelay(seconds: number | null | undefined): number {
  if (seconds == null || !Number.isFinite(seconds)) return DEFAULT_FRAME_DELAY_S
  return seconds <= MIN_FRAME_DELAY_S + 1e-9 ? DEFAULT_FRAME_DELAY_S : seconds
}

export interface FrameTimeline {
  /** Start time (s) of each frame. */
  readonly starts: readonly number[]
  /** Clamped duration (s) of each frame. */
  readonly durations: readonly number[]
  /** Sum of durations (s). */
  readonly total: number
}

/** Build a timeline from raw per-frame delays in seconds (clamped here). */
export function buildFrameTimeline(
  rawDelays: readonly (number | null)[],
): FrameTimeline {
  const starts: number[] = []
  const durations: number[] = []
  let t = 0
  for (const raw of rawDelays) {
    const d = clampFrameDelay(raw)
    starts.push(t)
    durations.push(d)
    t += d
  }
  return { starts, durations, total: t }
}

/**
 * Index of the frame shown at time `t`. Looping wraps modulo the total;
 * otherwise times before 0 show frame 0 and times past the end hold the last.
 */
export function frameIndexAt(tl: FrameTimeline, t: number, loop: boolean): number {
  const n = tl.starts.length
  if (n <= 1 || !(tl.total > 0)) return 0
  let local = Number.isFinite(t) ? t : 0
  if (loop) {
    local %= tl.total
    if (local < 0) local += tl.total
    // Summed float delays (0.1 + 0.2 + 0.3 > 0.6): treat "at the end" as the start.
    if (tl.total - local < 1e-9) local = 0
  } else if (local >= tl.total) {
    return n - 1
  }
  if (local <= 0) return 0
  // Last frame whose start <= local.
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((tl.starts[mid] ?? Infinity) <= local + 1e-9) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Closest frame to `target` for which `has(i)` is true, preferring earlier
 * frames on ties (a brief stall looks better than skipping ahead). Wraps
 * around when `loop`. Returns -1 when nothing is available.
 */
export function nearestAvailableFrame(
  target: number,
  has: (i: number) => boolean,
  frameCount: number,
  loop: boolean,
): number {
  if (frameCount <= 0) return -1
  for (let d = 0; d < frameCount; d++) {
    for (const cand of d === 0 ? [target] : [target - d, target + d]) {
      let i = cand
      if (loop) i = ((i % frameCount) + frameCount) % frameCount
      else if (i < 0 || i >= frameCount) continue
      if (has(i)) return i
    }
  }
  return -1
}

/** Whether every frame of a w×h animation fits the pre-decode budget. */
export function shouldPredecode(
  width: number,
  height: number,
  frameCount: number,
  budget = PREDECODE_BUDGET_BYTES,
): boolean {
  return width * height * 4 * frameCount <= budget
}

/** LRU capacity (frames) for on-demand mode: at least prefetch window + 2. */
export function onDemandCapacity(
  width: number,
  height: number,
  budget = ONDEMAND_BUDGET_BYTES,
): number {
  const bytes = Math.max(1, width * height * 4)
  return Math.max(PREFETCH_AHEAD + 2, Math.floor(budget / bytes))
}

/** `ImageTrack.repetitionCount`: 0 = play once, Infinity / N = repeat. */
export function loopsFromRepetitionCount(rep: number): boolean {
  return rep !== 0
}

// ── WebCodecs plumbing ──────────────────────────────────────────────────────

export interface AnimatedImageInfo {
  animated: boolean
  frameCount: number
  /** One play-through, seconds. */
  duration: number
  width: number
  height: number
  loop: boolean
}

export function imageDecoderAvailable(): boolean {
  return typeof ImageDecoder !== 'undefined'
}

async function openDecoder(file: Blob, mime: string): Promise<ImageDecoder | null> {
  if (!imageDecoderAvailable()) return null
  try {
    if (!(await ImageDecoder.isTypeSupported(mime))) return null
  } catch {
    return null
  }
  const bytes = await readBlobBytes(file)
  const decoder = new ImageDecoder({ data: bytes, type: mime, preferAnimation: true })
  try {
    await decoder.tracks.ready
    // All data is already in memory; this makes frameCount final (GIF counts grow while streaming).
    await decoder.completed
  } catch (err) {
    decoder.close()
    throw err
  }
  return decoder
}

function selectedTrack(decoder: ImageDecoder): ImageTrack | null {
  return decoder.tracks.selectedTrack
}

/** Seconds; VideoFrame.duration is in microseconds and may be null. */
function frameDelay(frame: VideoFrame): number | null {
  return frame.duration == null ? null : frame.duration / 1e6
}

/**
 * Probe an image file: frame count, total duration (clamped delays),
 * dimensions, loop flag. Null when WebCodecs can't decode this type.
 */
export async function probeAnimatedImage(
  file: Blob,
  mime: string,
): Promise<AnimatedImageInfo | null> {
  let decoder: ImageDecoder | null
  try {
    decoder = await openDecoder(file, mime)
  } catch {
    return null
  }
  if (!decoder) return null
  try {
    const track = selectedTrack(decoder)
    if (!track) return null
    const frameCount = Math.max(1, track.frameCount)
    const delays: (number | null)[] = []
    let width = 0
    let height = 0
    const count = track.animated ? frameCount : 1
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      try {
        if (i === 0) {
          width = image.displayWidth
          height = image.displayHeight
        }
        delays.push(frameDelay(image))
      } finally {
        image.close()
      }
    }
    const animated = track.animated && frameCount > 1
    return {
      animated,
      frameCount,
      duration: animated ? buildFrameTimeline(delays).total : 0,
      width,
      height,
      loop: animated && loopsFromRepetitionCount(track.repetitionCount),
    }
  } catch {
    return null
  } finally {
    decoder.close()
  }
}

class AnimatedImageProvider implements FrameProvider {
  readonly width: number
  readonly height: number
  readonly ready: Promise<void>
  private tl: FrameTimeline = {
    starts: [0],
    durations: [DEFAULT_FRAME_DELAY_S],
    total: 0,
  }
  private readonly frameCount: number
  private readonly cache: LRUCache<number, ImageBitmap>
  private readonly predecode: boolean
  private readonly pending = new Map<number, Promise<void>>()
  private readonly failed = new Set<number>()
  private readonly listeners = new Set<() => void>()
  /** Serializes decoder calls. */
  private chain: Promise<void> = Promise.resolve()
  /** Latest frame `frameAt` wanted but couldn't serve exactly. */
  private missed = -1
  /** Latest frame index asked for (prefetch tasks far from it are skipped). */
  private target = 0
  private disposed = false

  private readonly decoder: ImageDecoder

  constructor(
    decoder: ImageDecoder,
    first: ImageBitmap,
    firstDelay: number | null,
    frameCount: number,
  ) {
    this.decoder = decoder
    this.width = first.width
    this.height = first.height
    this.frameCount = frameCount
    this.predecode = shouldPredecode(this.width, this.height, frameCount)
    const capacity = this.predecode
      ? frameCount
      : Math.min(frameCount, onDemandCapacity(this.width, this.height))
    this.cache = new LRUCache<number, ImageBitmap>(capacity, (_k, bmp) => {
      bmp.close()
    })
    this.cache.set(0, first)
    this.ready = this.scan(firstDelay)
    // Keep unhandled-rejection noise out of the console; callers await `ready`.
    this.ready.catch(() => {})
  }

  get duration(): number {
    return this.tl.total
  }

  /** Read every frame's delay (keeping bitmaps when pre-decoding). */
  private async scan(firstDelay: number | null): Promise<void> {
    const delays: (number | null)[] = [firstDelay]
    for (let i = 1; i < this.frameCount; i++) {
      if (this.disposed) return
      await this.enqueue(async () => {
        const { image } = await this.decoder.decode({ frameIndex: i })
        try {
          delays.push(frameDelay(image))
          if (this.predecode) {
            const bmp = await createImageBitmap(image)
            if (this.disposed) bmp.close()
            else this.cache.set(i, bmp)
          }
        } finally {
          image.close()
        }
      })
    }
    this.tl = buildFrameTimeline(delays)
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task)
    this.chain = run.catch(() => {})
    return run
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }

  private isWanted(i: number): boolean {
    const ahead = (i - this.target + this.frameCount) % this.frameCount
    return ahead <= PREFETCH_AHEAD
  }

  /** Decode frame `i` into the cache. `force` skips the "still wanted" check. */
  private request(i: number, force: boolean): Promise<void> {
    if (this.disposed || this.cache.has(i) || this.failed.has(i))
      return Promise.resolve()
    const existing = this.pending.get(i)
    if (existing) return existing
    const p = this.enqueue(async () => {
      if (this.disposed || this.cache.has(i)) return
      if (!force && !this.isWanted(i)) return
      const { image } = await this.decoder.decode({ frameIndex: i })
      let bmp: ImageBitmap
      try {
        bmp = await createImageBitmap(image)
      } finally {
        image.close()
      }
      if (this.disposed) {
        bmp.close()
        return
      }
      this.cache.set(i, bmp)
      if (i === this.missed) {
        this.missed = -1
        this.notify()
      }
    })
      .catch(() => {
        this.failed.add(i)
      })
      .finally(() => {
        this.pending.delete(i)
      })
    this.pending.set(i, p)
    return p
  }

  private prefetch(from: number): void {
    if (this.predecode) return
    for (let k = 1; k <= PREFETCH_AHEAD && k < this.frameCount; k++) {
      void this.request((from + k) % this.frameCount, false)
    }
  }

  frameAt(t: number, loop: boolean): CanvasImageSource | null {
    if (this.disposed) return null
    const idx = frameIndexAt(this.tl, t, loop)
    this.target = idx
    const hit = this.cache.get(idx)
    if (hit) {
      this.prefetch(idx)
      return hit
    }
    this.missed = idx
    void this.request(idx, true)
    this.prefetch(idx)
    const near = nearestAvailableFrame(
      idx,
      (i) => this.cache.has(i),
      this.frameCount,
      loop,
    )
    return near >= 0 ? (this.cache.get(near) ?? null) : null
  }

  async prepare(t: number, loop: boolean): Promise<void> {
    await this.ready
    const idx = frameIndexAt(this.tl, t, loop)
    this.target = idx
    await this.request(idx, true)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.cache.clear()
    // Let queued decodes settle before closing the decoder they use.
    void this.chain.then(() => {
      this.decoder.close()
    })
  }
}

/**
 * Frame provider for an animated image. Resolves once the first frame is
 * decoded (size known); `ready` resolves once all frame delays are known
 * (and, under the pre-decode budget, every frame is decoded).
 */
export async function createAnimatedImageProvider(
  file: Blob,
  mime: string,
): Promise<FrameProvider> {
  const decoder = await openDecoder(file, mime)
  if (!decoder) throw new Error(`This system can't decode ${mime} animations`)
  try {
    const track = selectedTrack(decoder)
    if (!track) throw new Error('The image has no frames')
    const frameCount = track.animated ? Math.max(1, track.frameCount) : 1
    const { image } = await decoder.decode({ frameIndex: 0 })
    let first: ImageBitmap
    let delay: number | null
    try {
      delay = frameDelay(image)
      first = await createImageBitmap(image)
    } finally {
      image.close()
    }
    return new AnimatedImageProvider(decoder, first, delay, frameCount)
  } catch (err) {
    decoder.close()
    throw err
  }
}
