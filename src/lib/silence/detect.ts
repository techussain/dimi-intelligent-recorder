/**
 * Silence detection on a loudness envelope (one dB value per short frame).
 * Everything here is pure; the envelope itself is computed in a worker.
 */
import type { Clip } from '../timeline/types'
import type { TimeRange } from '../timeline/cutRanges'

/** Envelope frame length in seconds (20 ms). */
export const FRAME_SEC = 0.02

/** Loudness envelope of a file's audio. `start` = the audio's first timestamp. */
export interface Envelope {
  frameSec: number
  start: number
  db: Float32Array
}

export interface SilenceOptions {
  /** Frames quieter than this (dBFS) count as silence. */
  thresholdDb: number
  /** Only pauses at least this long are removed. */
  minSilenceSec: number
  /** Silence kept next to speech on each side, so words aren't clipped. */
  paddingSec: number
}

export const DEFAULT_MIN_SILENCE_SEC = 0.6
export const DEFAULT_PADDING_SEC = 0.15

/**
 * Streaming RMS loudness in dBFS per FRAME_SEC frame (channels averaged).
 * Chunk boundaries don't matter.
 */
export class EnvelopeBuilder {
  private readonly frameLen: number
  private sumSq = 0
  private n = 0
  private out: number[] = []

  constructor(sampleRate: number, frameSec = FRAME_SEC) {
    this.frameLen = Math.max(1, Math.round(sampleRate * frameSec))
  }

  push(channels: readonly Float32Array[], frames: number): void {
    const nc = channels.length
    if (nc === 0) return
    for (let i = 0; i < frames; i++) {
      let v = 0
      for (let c = 0; c < nc; c++) v += channels[c]![i]!
      v /= nc
      this.sumSq += v * v
      if (++this.n === this.frameLen) this.flush()
    }
  }

  finish(): Float32Array {
    if (this.n > 0) this.flush()
    return Float32Array.from(this.out)
  }

  private flush(): void {
    this.out.push(10 * Math.log10(this.sumSq / this.n + 1e-12))
    this.sumSq = 0
    this.n = 0
  }
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return -90
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

/**
 * A silence level for this recording: a little above its noise floor (quiet
 * 15th percentile) but clearly below speech (loud 90th percentile). Clamped
 * to a sensible range. Digital silence (-90 dB and below) is ignored when
 * estimating the floor.
 */
export function autoThreshold(db: Float32Array): number {
  const audible = db.filter((v) => v > -90).sort()
  if (audible.length === 0) return -45
  const noise = percentile(audible, 0.15)
  const speech = percentile(audible, 0.9)
  const t = Math.min(noise + 8, speech - 12)
  return Math.round(Math.max(-60, Math.min(-25, t)))
}

/**
 * Silent stretches in the file's own time (seconds, including `env.start`),
 * at least `minSilenceSec` long, shrunk by `paddingSec` on sides that touch
 * sound. Leading/trailing silence is only padded on its speech side.
 */
export function detectSilences(env: Envelope, opts: SilenceOptions): TimeRange[] {
  const { db, frameSec, start } = env
  const out: TimeRange[] = []
  let runStart = -1
  const close = (endFrame: number) => {
    const s = runStart * frameSec
    const e = endFrame * frameSec
    if (e - s >= opts.minSilenceSec) {
      const a = runStart === 0 ? s : s + opts.paddingSec
      const b = endFrame >= db.length ? e : e - opts.paddingSec
      if (b - a > 0.05) out.push({ start: start + a, end: start + b })
    }
    runStart = -1
  }
  for (let i = 0; i < db.length; i++) {
    const quiet = db[i]! < opts.thresholdDb
    if (quiet && runStart < 0) runStart = i
    else if (!quiet && runStart >= 0) close(i)
  }
  if (runStart >= 0) close(db.length)
  return out
}

/**
 * Map silences (file time) through a clip onto the timeline, keeping only the
 * parts inside the clip's trimmed range. Speed is respected.
 */
export function silencesOnTimeline(
  clip: Clip,
  silences: readonly TimeRange[],
): TimeRange[] {
  const sp = Math.max(0.1, clip.speed || 1)
  const out: TimeRange[] = []
  for (const r of silences) {
    const a = Math.max(r.start, clip.sourceIn)
    const b = Math.min(r.end, clip.sourceOut)
    if (b - a <= 0.05) continue
    out.push({
      start: clip.timelineStart + (a - clip.sourceIn) / sp,
      end: clip.timelineStart + (b - clip.sourceIn) / sp,
    })
  }
  return out
}
